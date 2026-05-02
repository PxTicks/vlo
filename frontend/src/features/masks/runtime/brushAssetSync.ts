import type { BrushPaintedBounds } from "../../../types/TimelineTypes";
import {
  countBrushMaskAssetConsumers,
  useTimelineStore,
} from "../../timeline";
import { useAssetStore } from "../../userAssets";
import { extractBrushPng, getBrushBuffer } from "./brushBufferRegistry";

/**
 * Debounce window for brush asset persistence. Each pointer-up resets the
 * timer; we only ingest a PNG into the asset store once the user pauses
 * painting. Tuned so quick stroke flurries don't churn `addLocalAsset` (which
 * surfaces UI feedback the user otherwise sees flickering).
 */
const COMMIT_DEBOUNCE_MS = 600;

interface PendingCommit {
  parentClipId: string;
  maskClipId: string;
  maskLocalId: string;
  timer: ReturnType<typeof setTimeout>;
  inflight: Promise<void> | null;
  /** Tracks whether more strokes arrived while a flush was in progress. */
  redirty: boolean;
}

const pendingCommits = new Map<string, PendingCommit>();

/**
 * Persist the live brush buffer for the given mask as a PNG asset and write
 * `brushMaskAssetId` + `brushPaintedBounds` to the mask. The PNG is cropped
 * on extract to the painted region — disk size matches what's actually
 * been painted, not the full canvas.
 *
 * The previous backing PNG is deleted when no other clip references it.
 *
 * Returns the new asset id, or null if there's nothing to persist (e.g. an
 * empty buffer or the renderer hasn't been wired yet).
 */
export async function commitBrushMaskAsset(
  parentClipId: string,
  maskClipId: string,
  maskLocalId: string,
  previousAssetId: string | undefined,
  paintedBounds: BrushPaintedBounds | null,
): Promise<string | null> {
  if (!paintedBounds || paintedBounds.width <= 0 || paintedBounds.height <= 0) {
    // Nothing painted: clear any existing asset reference.
    useTimelineStore.getState().updateClipMask(parentClipId, maskLocalId, {
      brushMaskAssetId: undefined,
      brushPaintedBounds: undefined,
    });
    if (previousAssetId) {
      try {
        const remaining = countBrushMaskAssetConsumers(
          useTimelineStore.getState().clips,
          previousAssetId,
        );
        if (remaining === 0) {
          await useAssetStore.getState().deleteAsset(previousAssetId);
        }
      } catch (error) {
        console.warn("Failed to delete previous brush asset", error);
      }
    }
    return null;
  }

  const blob = await extractBrushPng(maskClipId, paintedBounds);
  if (!blob) return null;

  const now = Date.now();
  const file = new File([blob], `brush_${maskLocalId}_${now}.png`, {
    type: "image/png",
    lastModified: now,
  });

  const created = await useAssetStore.getState().addLocalAsset(file, {
    source: "brush_mask",
    parentClipId,
    maskClipId,
  });
  if (!created) return null;

  useTimelineStore.getState().updateClipMask(parentClipId, maskLocalId, {
    brushMaskAssetId: created.id,
    brushPaintedBounds: paintedBounds,
  });

  if (previousAssetId && previousAssetId !== created.id) {
    try {
      const remaining = countBrushMaskAssetConsumers(
        useTimelineStore.getState().clips,
        previousAssetId,
      );
      if (remaining === 0) {
        await useAssetStore.getState().deleteAsset(previousAssetId);
      }
    } catch (error) {
      console.warn("Failed to delete previous brush asset", error);
    }
  }

  return created.id;
}

/**
 * Schedule a debounced commit for the given brush mask. Each call resets the
 * timer; when it fires, we read `paintedBounds` from the live buffer at that
 * moment and persist a PNG asset. If a stroke happens while a flush is
 * in-flight, we mark the entry redirty and re-arm once the flush settles.
 */
export function scheduleBrushMaskCommit(
  parentClipId: string,
  maskClipId: string,
  maskLocalId: string,
): void {
  const existing = pendingCommits.get(maskClipId);
  if (existing) {
    clearTimeout(existing.timer);
    if (existing.inflight) {
      existing.redirty = true;
    }
  }

  const flush = async () => {
    const entry = pendingCommits.get(maskClipId);
    if (!entry) return;

    const previousAssetId = useTimelineStore
      .getState()
      .clips.find(
        (clip) => clip.type === "mask" && clip.id === maskClipId,
      )?.brushMaskAssetId;
    const paintedBounds = getBrushBuffer(maskClipId)?.paintedBounds ?? null;

    const promise = commitBrushMaskAsset(
      parentClipId,
      maskClipId,
      maskLocalId,
      previousAssetId,
      paintedBounds,
    )
      .catch((error) => {
        console.warn("Failed to commit brush mask asset", error);
        return null;
      })
      .then(() => {
        const after = pendingCommits.get(maskClipId);
        if (!after) return;
        if (after.redirty) {
          // Strokes arrived during the flush — re-arm the debounce.
          after.redirty = false;
          after.inflight = null;
          after.timer = setTimeout(() => {
            void flush();
          }, COMMIT_DEBOUNCE_MS);
        } else {
          pendingCommits.delete(maskClipId);
        }
      });
    entry.inflight = promise;
  };

  const next: PendingCommit = {
    parentClipId,
    maskClipId,
    maskLocalId,
    inflight: existing?.inflight ?? null,
    redirty: existing?.redirty ?? false,
    timer: setTimeout(() => {
      void flush();
    }, COMMIT_DEBOUNCE_MS),
  };
  pendingCommits.set(maskClipId, next);
}

/**
 * Cancel any scheduled commit and force the buffer to flush immediately.
 * Called from places that need the asset to be up-to-date *now* (e.g. clear
 * action, mask deletion).
 */
export async function flushBrushMaskCommit(maskClipId: string): Promise<void> {
  const entry = pendingCommits.get(maskClipId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingCommits.delete(maskClipId);
  if (entry.inflight) {
    await entry.inflight;
  }
  const previousAssetId = useTimelineStore
    .getState()
    .clips.find(
      (clip) => clip.type === "mask" && clip.id === maskClipId,
    )?.brushMaskAssetId;
  const paintedBounds = getBrushBuffer(maskClipId)?.paintedBounds ?? null;
  await commitBrushMaskAsset(
    entry.parentClipId,
    maskClipId,
    entry.maskLocalId,
    previousAssetId,
    paintedBounds,
  ).catch((error) => {
    console.warn("Failed to flush brush mask asset", error);
  });
}
