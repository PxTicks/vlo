import type { Asset } from "../../../types/Asset";
import type {
  ClipTransform,
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import {
  ensureAssetSourceLoaded,
  getAssets,
} from "../../userAssets/publicApi";
import { useAssetStore } from "../../userAssets/useAssetStore";
import {
  reverseAssetFile,
  type ReverseAssetFileOptions,
} from "../../userAssets/services/AssetReversalService";
import { reverseTransformationStack } from "../../transformations/utils/reverseTransformations";
import { reverseMaskTimelineClip } from "../../masks/utils/reverseMask";
import {
  getOrderedChildMaskClips,
  parseMaskClipId,
} from "../model/maskClipModel";
import { useTimelineStore } from "../useTimelineStore";
import { beginClipReversal, endClipReversal } from "../hooks/useClipReversalStore";
import type { Component, MarkerEntry, MarkersComponent } from "../../../types/Components";

/**
 * Right-click "Reverse" orchestration for an asset-backed clip.
 *
 * Sequence:
 *   1. Generate (or reuse) a reversed copy of the clip's source asset.
 *   2. Compute mirrored trim/offset fields so the visual window stays put.
 *   3. Time-invert every spline on the clip's transformation stack via
 *      [reverseTransformationStack](../../transformations/utils/reverseTransformations.ts).
 *   4. Apply the same reversal recipe to each child mask clip's points,
 *      active range, and transformations.
 *   5. Mirror any `markers` component's source-time markers.
 *   6. Hot-swap the asset on the clip.
 *
 * Each step commits to the timeline store independently so undo/redo lands at
 * a coherent state if the user reverses mid-operation.
 */

export interface ReverseClipOptions {
  onProgress?: ReverseAssetFileOptions["onProgress"];
  /**
   * When true (default), reuses any existing asset in the store whose
   * `creationMetadata` flags it as a reversal of the same source. Setting
   * this to false forces a fresh reverse-encode.
   */
  reuseExistingReversedAsset?: boolean;
}

export class ClipReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipReversalError";
  }
}

function findExistingReversedAsset(sourceAssetId: string): Asset | null {
  const reverseSource = getAssets().find((asset) => {
    const meta = asset.creationMetadata;
    return (
      meta?.source === "reversed" && meta.sourceAssetId === sourceAssetId
    );
  });
  return reverseSource ?? null;
}

/**
 * If `asset` was itself produced by an earlier reversal of some original X,
 * and X is still in the store, return X. Reversing a reversed asset round-
 * trips to the original — no decoding required. Returns null when no
 * round-trip is available.
 */
function findRoundTripOriginalAsset(asset: Asset): Asset | null {
  const meta = asset.creationMetadata;
  if (!meta || meta.source !== "reversed") return null;
  const original = getAssets().find(
    (candidate) => candidate.id === meta.sourceAssetId,
  );
  return original ?? null;
}

async function obtainReversedAsset(
  clipAsset: Asset,
  options: ReverseClipOptions,
): Promise<Asset> {
  if (options.reuseExistingReversedAsset !== false) {
    // Fast path A: clip is on a reversed asset; flipping it again gives back
    // the still-existing original.
    const roundTrip = findRoundTripOriginalAsset(clipAsset);
    if (roundTrip) return roundTrip;

    // Fast path B: someone already produced a reversed twin of this exact
    // source asset earlier in the session.
    const cached = findExistingReversedAsset(clipAsset.id);
    if (cached) return cached;
  }

  const hydrated = await ensureAssetSourceLoaded(clipAsset.id);
  const file = hydrated?.file;
  if (!file) {
    throw new ClipReversalError(
      "Source file is not available for reversal; ensure the asset is hydrated.",
    );
  }

  const { file: reversedFile } = await reverseAssetFile(file, {
    onProgress: options.onProgress,
  });

  const newAsset = await useAssetStore.getState().addLocalAsset(
    reversedFile,
    { source: "reversed", sourceAssetId: clipAsset.id },
    undefined,
    { allowDuplicateHash: true },
  );

  if (!newAsset) {
    throw new ClipReversalError("Failed to ingest the reversed asset.");
  }
  return newAsset;
}

function computeReversedClipShape(
  clip: TimelineClip & { sourceDuration: number },
): { offset: number; transformedOffset: number } {
  const sourceDuration = clip.sourceDuration;
  const reversedOffset = Math.max(
    0,
    sourceDuration - clip.offset - clip.croppedSourceDuration,
  );
  const reversedTransformedOffset = Math.max(
    0,
    clip.transformedDuration - clip.transformedOffset - clip.timelineDuration,
  );
  return {
    offset: reversedOffset,
    transformedOffset: reversedTransformedOffset,
  };
}

function reverseMarkersInComponents(
  components: readonly Component[] | undefined,
  sourceDurationTicks: number,
): { id: string; component: MarkersComponent }[] {
  const result: { id: string; component: MarkersComponent }[] = [];
  if (!components) return result;
  for (const component of components) {
    if (component.type !== "markers") continue;
    const nextMarkers: MarkerEntry[] = component.parameters.markers
      .map((marker) => ({
        ...marker,
        sourceTimeTicks: sourceDurationTicks - marker.sourceTimeTicks,
      }))
      .sort((a, b) => a.sourceTimeTicks - b.sourceTimeTicks);
    result.push({
      id: component.id,
      component: {
        ...component,
        parameters: { ...component.parameters, markers: nextMarkers },
      },
    });
  }
  return result;
}

/**
 * Reverse a single asset-backed timeline clip in place.
 *
 * Returns the new asset that the clip was swapped onto, or `null` when the
 * clip cannot be reversed (e.g. still image, missing source duration).
 */
export async function reverseTimelineClip(
  clipId: string,
  options: ReverseClipOptions = {},
): Promise<Asset | null> {
  const store = useTimelineStore.getState();
  const clip = store.clips.find((candidate) => candidate.id === clipId);
  if (!clip) {
    throw new ClipReversalError(`Clip '${clipId}' not found.`);
  }
  if (!isAssetBackedClip(clip)) {
    throw new ClipReversalError(
      "Only video/audio clips can currently be reversed.",
    );
  }
  if (
    clip.type === "image" ||
    !clip.sourceDuration ||
    !Number.isFinite(clip.sourceDuration) ||
    clip.sourceDuration <= 0
  ) {
    throw new ClipReversalError(
      "This clip has no finite source duration and cannot be reversed.",
    );
  }

  const sourceAsset = getAssets().find((asset) => asset.id === clip.assetId);
  if (!sourceAsset) {
    throw new ClipReversalError("Clip's source asset is missing from the store.");
  }

  const sourceDurationTicks = clip.sourceDuration;

  // Flag the clip as "reversing" so the timeline overlay can show a
  // "Rendering reverse…" badge until the hot-swap commits. Cleared in the
  // finally below, covering both the slow re-encode path and the instant
  // round-trip / cached-twin paths.
  beginClipReversal(clipId);
  try {
    // 1. Reversed asset (cached or freshly encoded).
    const reversedAsset = await obtainReversedAsset(sourceAsset, options);

    // 2. Reverse transformations.
    const reversedTransforms = reverseTransformationStack(
      clip.transformations ?? [],
      sourceDurationTicks,
    );

    // 3. Compute new clip shape (mirror around source / transformed midpoints).
    const reversedShape = computeReversedClipShape({
      ...clip,
      sourceDuration: sourceDurationTicks,
    });

    // 4. Reverse markers components (carry source-tick markers). Asset-backed
    // clips never have `type === "mask"`, but TS doesn't see the narrowing so
    // we pluck `components` defensively.
    const components =
      "components" in clip ? clip.components : undefined;
    const reversedMarkerComponents = reverseMarkersInComponents(
      components,
      sourceDurationTicks,
    );

    // 5. Collect child masks (pre-mutation snapshot).
    const childMasks = getOrderedChildMaskClips(store.clips, clip);

    // --- Apply store mutations sequentially ---

    // 5a. Hot-swap asset reference (assetId + name).
    store.replaceClipAsset(clipId, reversedAsset);

    // 5b. Update clip trim / transformedOffset so the visual window mirrors.
    store.updateClipShape(clipId, reversedShape);

    // 5c. Apply reversed transformations stack.
    store.setClipTransforms(clipId, reversedTransforms);

    // 5d. Replace markers (if any) on the clip's components.
    for (const { id, component } of reversedMarkerComponents) {
      useTimelineStore.getState().updateClipComponent(
        clipId,
        id,
        () => component,
      );
    }

    // 5e. Reverse each child mask's transformations + points + activeRange.
    for (const mask of childMasks) {
      applyMaskReversal(mask, clipId, sourceDurationTicks);
    }

    return reversedAsset;
  } finally {
    endClipReversal(clipId);
  }
}

function applyMaskReversal(
  maskClip: MaskTimelineClip,
  parentClipId: string,
  sourceDurationTicks: number,
): void {
  const reversedMask = reverseMaskTimelineClip(maskClip, sourceDurationTicks);
  const reversedTransforms: ClipTransform[] = reverseTransformationStack(
    maskClip.transformations ?? [],
    sourceDurationTicks,
  );

  const parsed = parseMaskClipId(maskClip.id);
  if (!parsed || parsed.clipId !== parentClipId) return;

  useTimelineStore.getState().updateClipMask(parentClipId, parsed.maskId, {
    maskPoints: reversedMask.maskPoints,
    activeRange: reversedMask.activeRange ?? null,
    transformations: reversedTransforms,
    sam2GeneratedPointsHash: reversedMask.sam2GeneratedPointsHash,
    sam2MaskAssetId: reversedMask.sam2MaskAssetId,
    sam2LastGeneratedAt: reversedMask.sam2LastGeneratedAt,
  });
}
