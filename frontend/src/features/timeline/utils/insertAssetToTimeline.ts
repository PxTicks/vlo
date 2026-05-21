import type { Asset } from "../../../types/Asset";
import type {
  BaseClip,
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { createClipFromAsset } from "./clipFactory";
import { useTimelineStore } from "../useTimelineStore";
import { getTrackTypeFromClipType } from "./formatting";

const DEFAULT_GENERATED_MASK_OUTER_FEATHER = 30;

function clipOverlapsRange(
  clip: TimelineClip,
  startTick: number,
  endTick: number,
): boolean {
  if (clip.type === "mask") {
    return false;
  }

  const clipEnd = clip.start + clip.timelineDuration;
  return clip.start < endTick && clipEnd > startTick;
}

function isCompatibleTrackType(
  trackType: string | undefined,
  expectedTrackType: string,
): boolean {
  return !trackType || trackType === expectedTrackType;
}

function createDefaultGeneratedMaskTransforms(): ClipTransform[] {
  return [
    {
      id: crypto.randomUUID(),
      type: "feather",
      isEnabled: true,
      parameters: {
        mode: "hard_outer",
        amount: DEFAULT_GENERATED_MASK_OUTER_FEATHER,
        invert: false,
      },
    },
  ];
}

/**
 * If the asset has a linked generation mask, attach it as a child mask clip
 * and seed shared mask feathering on the parent when unset.
 */
export function attachGenerationMask(
  clipId: string,
  asset: Asset,
): void {
  const meta = asset.creationMetadata;
  if (meta?.source !== "generated" || !meta.generationMaskAssetId) return;

  const store = useTimelineStore.getState();
  store.addClipMask(clipId, {
    id: crypto.randomUUID(),
    type: "generation",
    isEnabled: true,
    mode: "apply",
    inverted: false,
    parameters: { baseWidth: 1, baseHeight: 1 },
    generationMaskAssetId: meta.generationMaskAssetId,
    transformations: [],
  });
  store.setClipMaskCompositionAlgebra(clipId, "normal");

  const parentClip = store.clips.find(
    (clip): clip is Extract<TimelineClip, { type: Exclude<TimelineClip["type"], "mask"> }> =>
      clip.id === clipId && clip.type !== "mask",
  );

  if (parentClip) {
    const existingComposition = (parentClip.components ?? []).find(
      (component) => component.type === "mask_composition",
    );
    const existingTransforms =
      existingComposition?.type === "mask_composition"
        ? existingComposition.parameters.compositeTransformations
        : [];
    if (existingTransforms.length === 0) {
      store.setClipMaskCompositeTransforms(
        clipId,
        createDefaultGeneratedMaskTransforms(),
      );
    }
  }
}

export function insertBaseClipAtTime(
  baseClip: BaseClip,
  startTick: number,
): string | null {
  const store = useTimelineStore.getState();
  const expectedTrackType = getTrackTypeFromClipType(baseClip.type);
  const endTick = startTick + baseClip.timelineDuration;

  const placeClip = (trackId: string): string => {
    const clip: TimelineClip = {
      ...baseClip,
      trackId,
      start: startTick,
    } as TimelineClip;
    store.addClip(clip);
    return clip.id;
  };

  // Find the topmost compatible track with content in the drop zone
  let topmostOccupiedIndex = -1;
  for (let i = 0; i < store.tracks.length; i++) {
    const track = store.tracks[i];
    if (!isCompatibleTrackType(track.type, expectedTrackType)) {
      continue;
    }

    const occupied = store.clips.some(
      (clip) =>
        clip.trackId === track.id && clipOverlapsRange(clip, startTick, endTick),
    );

    if (occupied) {
      topmostOccupiedIndex = i;
      break;
    }
  }

  if (topmostOccupiedIndex === -1) {
    // Nothing occupied — use the bottom-most compatible track
    for (let i = store.tracks.length - 1; i >= 0; i--) {
      const track = store.tracks[i];
      if (isCompatibleTrackType(track.type, expectedTrackType)) {
        return placeClip(track.id);
      }
    }
  } else {
    // We found an occupied compatible track.
    // Try to find the first compatible track above it.
    let aboveTrackId: string | null = null;
    for (let i = topmostOccupiedIndex - 1; i >= 0; i--) {
      const track = store.tracks[i];
      if (isCompatibleTrackType(track.type, expectedTrackType)) {
        aboveTrackId = track.id;
        break;
      }
    }

    if (aboveTrackId) {
      return placeClip(aboveTrackId);
    }

    // No compatible track above the topmost occupied track — insert a new one
    // directly above the topmost occupied track index.
    const newTrackId = store.insertTrack(topmostOccupiedIndex);
    return placeClip(newTrackId);
  }

  // Fallback: insert a new track at 0
  const newTrackId = store.insertTrack(0);
  return placeClip(newTrackId);
}


/**
 * Inserts an asset into the timeline at the given start tick.
 *
 * Placement strategy: use the topmost compatible track that is free in the
 * requested range. If all compatible tracks are occupied, insert a new track
 * above the current compatible stack.
 */
export function insertAssetAtTime(asset: Asset, startTick: number): void {
  const clipId = insertBaseClipAtTime(createClipFromAsset(asset), startTick);
  if (clipId) {
    attachGenerationMask(clipId, asset);
  }
}
