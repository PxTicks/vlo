import type {
  BrushPaintedBounds,
  MaskTimelineClip,
  TimelineSelection,
} from "../../../types/TimelineTypes";
import {
  getTimelineClips,
  getTimelineBrushMaskAssetConsumerCount,
  getTimelineBrushMaskClipIds,
  getTimelineMaskClipById,
  parseMaskClipId,
  updateTimelineClipMask,
} from "../../timeline/api";
import { useAssetStore } from "../../userAssets/useAssetStore";
import {
  disposeBrushBuffer,
  extractBrushPng,
  getBrushBuffer,
  getBrushBufferRevision,
  isBrushBufferDirty,
  isBrushBufferRevision,
  markBrushBufferClean,
  recalculateBrushPaintedBounds,
} from "./brushBufferRegistry";

interface CommitBrushMaskAssetOptions {
  shouldCommit?: () => boolean;
}

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
  options: CommitBrushMaskAssetOptions = {},
): Promise<string | null> {
  const shouldCommit = options.shouldCommit ?? (() => true);
  if (!shouldCommit()) return null;

  if (!paintedBounds || paintedBounds.width <= 0 || paintedBounds.height <= 0) {
    if (!shouldCommit()) return null;
    // Nothing painted: clear any existing asset reference.
    updateTimelineClipMask(parentClipId, maskLocalId, {
      brushMaskAssetId: undefined,
      brushPaintedBounds: undefined,
    });
    if (previousAssetId) {
      try {
        const remaining =
          getTimelineBrushMaskAssetConsumerCount(previousAssetId);
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
  if (!shouldCommit()) return null;

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
  if (!shouldCommit()) {
    try {
      await useAssetStore.getState().deleteAsset(created.id);
    } catch (error) {
      console.warn("Failed to delete stale brush asset", error);
    }
    return null;
  }

  updateTimelineClipMask(parentClipId, maskLocalId, {
    brushMaskAssetId: created.id,
    brushPaintedBounds: paintedBounds,
  });

  if (previousAssetId && previousAssetId !== created.id) {
    try {
      const remaining =
        getTimelineBrushMaskAssetConsumerCount(previousAssetId);
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
  return getTimelineMaskClipById(maskClipId);
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
 * Called from brush edit-session leave fallbacks and broader project
 * persistence flushes. While the brush panel is focused, the live buffer stays
 * authoritative; PNG materialization is a one-way bridge for reload/save flows.
 */
export async function flushBrushMaskCommit(maskClipId: string): Promise<void> {
  const existing = inflightFlushes.get(maskClipId);
  if (existing) {
    await existing;
    return;
  }
  const promise = (async () => {
    if (!isBrushBufferDirty(maskClipId)) return;
    const startingRevision = getBrushBufferRevision(maskClipId);
    const isStillCurrent = () =>
      isBrushBufferRevision(maskClipId, startingRevision);
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
    if (!isStillCurrent()) return;
    const hasPaintedBounds =
      !!paintedBounds &&
      paintedBounds.width > 0 &&
      paintedBounds.height > 0;

    try {
      const committedAssetId = await commitBrushMaskAsset(
        parsed.clipId,
        maskClipId,
        parsed.maskId,
        previousAssetId,
        paintedBounds,
        { shouldCommit: isStillCurrent },
      );
      if (!isStillCurrent()) {
        return;
      }
      if (hasPaintedBounds && !committedAssetId) {
        return;
      }
      markBrushBufferClean(maskClipId, committedAssetId);
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
  const brushMaskClipIds = getTimelineBrushMaskClipIds();

  await Promise.all(
    brushMaskClipIds.map((maskClipId) => flushBrushMaskCommit(maskClipId)),
  );
}

/**
 * Materialise dirty interactive brush pixels before a render takes a project
 * snapshot. Existing selections may contain cloned mask clips, so replace
 * matching clips with their post-flush timeline versions as part of the same
 * precondition.
 */
export async function prepareBrushMasksForTimelineRender(
  selection?: TimelineSelection,
  options: { refreshSelectionClips?: boolean } = {},
): Promise<TimelineSelection | undefined> {
  // Persisted selections are complete render snapshots. Opting out of refresh
  // must also avoid flushing or validating unrelated state in the open
  // timeline, otherwise replay can still fail because of live brush buffers.
  if (selection && options.refreshSelectionClips === false) {
    return selection;
  }

  await flushAllBrushMaskCommits();
  let dirtyMaskIds = getTimelineBrushMaskClipIds().filter(
    isBrushBufferDirty,
  );
  if (dirtyMaskIds.length > 0) {
    // A stroke may have landed while the first extraction was in flight.
    await Promise.all(dirtyMaskIds.map(flushBrushMaskCommit));
    dirtyMaskIds = dirtyMaskIds.filter(isBrushBufferDirty);
  }
  if (dirtyMaskIds.length > 0) {
    throw new Error(
      `Could not materialize brush masks for rendering: ${dirtyMaskIds.join(", ")}`,
    );
  }

  if (!selection) {
    return undefined;
  }

  const currentClipsById = new Map(
    getTimelineClips().map((clip) => [clip.id, clip] as const),
  );
  return {
    ...selection,
    clips: selection.clips.map(
      (clip) => currentClipsById.get(clip.id) ?? clip,
    ),
  };
}
