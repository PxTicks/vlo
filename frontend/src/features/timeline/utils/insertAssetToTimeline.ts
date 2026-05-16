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

  for (let i = 0; i < store.tracks.length; i++) {
    const track = store.tracks[i];
    if (!isCompatibleTrackType(track.type, expectedTrackType)) {
      continue;
    }

    const occupied = store.clips.some(
      (clip) =>
        clip.trackId === track.id && clipOverlapsRange(clip, startTick, endTick),
    );

    if (!occupied) {
      return placeClip(track.id);
    }
  }

  const firstCompatibleTrackIndex = store.tracks.findIndex((track) =>
    isCompatibleTrackType(track.type, expectedTrackType),
  );
  const insertIndex =
    firstCompatibleTrackIndex >= 0 ? firstCompatibleTrackIndex : 0;
  const newTrackId = store.insertTrack(insertIndex);
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
