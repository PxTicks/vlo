import type {
  BrushPaintedBounds,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import {
  countBrushMaskAssetConsumers,
  parseMaskClipId,
  useTimelineStore,
} from "../../timeline";
import { useAssetStore } from "../../userAssets";
import {
  disposeBrushBuffer,
  extractBrushPng,
  getBrushBuffer,
  isBrushBufferDirty,
  markBrushBufferClean,
  recalculateBrushPaintedBounds,
} from "./brushBufferRegistry";

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

function findMaskClip(maskClipId: string): MaskTimelineClip | null {
  const clip = useTimelineStore
    .getState()
    .clips.find((candidate) => candidate.id === maskClipId);
  if (!clip || clip.type !== "mask") return null;
  return clip;
}

/**
 * Coalesces concurrent flush calls so leave events that fire in quick
 * succession (e.g. tab switch + clip change) only trigger one ingestion.
 */
const inflightFlushes = new Map<string, Promise<void>>();

/**
 * Persist the buffer for `maskClipId` if it has unsaved strokes, and mark it
 * clean. No-ops if the buffer hasn't been touched since the last commit, so
 * spurious leave events (selecting a brush mask, then leaving without
 * painting) don't churn the asset store.
 *
 * Called from stroke-end commits, leave-navigation fallbacks, and broader
 * project persistence flushes. We still avoid per-move writes while the user
 * is actively dragging the brush, but once a stroke completes the PNG can be
 * materialized so reload/save flows behave like other asset-backed masks.
 */
export async function flushBrushMaskCommit(maskClipId: string): Promise<void> {
  const existing = inflightFlushes.get(maskClipId);
  if (existing) {
    await existing;
    return;
  }
  const promise = (async () => {
    if (!isBrushBufferDirty(maskClipId)) return;
    const parsed = parseMaskClipId(maskClipId);
    if (!parsed) return;

    const maskClip = findMaskClip(maskClipId);
    if (!maskClip) {
      disposeBrushBuffer(maskClipId);
      return;
    }
    const previousAssetId = maskClip?.brushMaskAssetId;
    const paintedBounds =
      (await recalculateBrushPaintedBounds(maskClipId)) ??
      getBrushBuffer(maskClipId)?.paintedBounds ??
      null;

    try {
      await commitBrushMaskAsset(
        parsed.clipId,
        maskClipId,
        parsed.maskId,
        previousAssetId,
        paintedBounds,
      );
      markBrushBufferClean(maskClipId);
    } catch (error) {
      console.warn("Failed to commit brush mask asset", error);
    }
  })();
  inflightFlushes.set(maskClipId, promise);
  try {
    await promise;
  } finally {
    inflightFlushes.delete(maskClipId);
  }
}

/**
 * Flush all brush-mask buffers that currently exist in the timeline. This is
 * used by broader project persistence flows so brush masks are materialized as
 * PNG assets before we persist timeline/assets documents or switch projects.
 */
export async function flushAllBrushMaskCommits(): Promise<void> {
  const brushMaskClipIds = useTimelineStore
    .getState()
    .clips.filter(
      (clip): clip is MaskTimelineClip =>
        clip.type === "mask" && clip.maskType === "brush",
    )
    .map((clip) => clip.id);

  await Promise.all(
    brushMaskClipIds.map((maskClipId) => flushBrushMaskCommit(maskClipId)),
  );
}
