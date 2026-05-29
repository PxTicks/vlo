import { resolveMaskCompositionAlgebra, type Component, type MaskCompositionAlgebra } from "../../../types/Components";
import type { Asset } from "../../../types/Asset";
import type {
  ClipMask,
  ClipTransform,
  MaskActiveRange,
  MaskBooleanExpression,
  MaskTimelineClip,
  StandardTimelineClip,
  TextClipData,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  isAssetBackedClip,
  isNonMaskTimelineClip,
  isTextClip,
} from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import {
  deriveTextClipName,
  resolveTextClipData,
} from "../../text/utils/textClipData";
import {
  appendMaskBooleanExpression,
  getMaskLocalId,
  resolveMaskBooleanExpression,
} from "../../masks/model/maskBooleanExpression";
import { TICKS_PER_SECOND } from "../constants";
import { getTrackTypeFromClipType } from "../utils/formatting";
import { getResizedClipLeft, getResizedClipRight } from "../utils/clipMath";
import { resolveCollision } from "../utils/collision";
import {
  addMaskClipComponent,
  buildMaskClipTransformations,
  cloneClipWithMasks,
  cloneTimelineClip,
  collectClipRemovalPlan,
  getChildMaskClipIds,
  getOrderedChildMaskClips,
  isInheritedTransformType,
  isMaskCompositionComponentMeaningful,
  makeMaskClipId,
  maskToClip,
  normalizeComponentsMaskComposite,
  parseMaskClipId,
  propagateParentToMasks,
  removeClipsFromDraft,
  setChildMaskClipIds,
  syncMaskEdgeTransformsToAlgebra,
  syncMaskInheritedSpeed,
  syncMaskTiming,
  updateMaskCompositionOnDraft,
} from "./maskClipModel";
import {
  createNewTrack,
  maybeTrimAndPadTracks,
  type TimelineModelState,
} from "./timelineTrackModel";

export type TimelineClipShape = Partial<
  Pick<
    TimelineClip,
    | "start"
    | "timelineDuration"
    | "offset"
    | "transformedDuration"
    | "transformedOffset"
    | "croppedSourceDuration"
  >
>;

export interface TimelineClipMove {
  clipId: string;
  start: number;
  trackId?: string;
}

export type TimelineMaskUpdate = Partial<
  Pick<
    MaskTimelineClip,
    | "name"
    | "maskMode"
    | "maskInverted"
    | "sam2GrowAmount"
    | "maskParameters"
    | "maskPoints"
    | "sam2MaskAssetId"
    | "sam2GeneratedPointsHash"
    | "sam2LastGeneratedAt"
    | "brushMaskAssetId"
    | "brushPaintedBounds"
  >
> & {
  transformations?: ClipTransform[];
  activeRange?: MaskActiveRange | null;
};

export interface TimelineRemovalPlan {
  clipIdsToRemove: Set<string>;
  brushMaskClipIdsToDispose: string[];
  sam2MaskAssetIdsToDelete: Set<string>;
  compositeProxyAssetIdsToDelete: Set<string>;
}

function collectCompositeProxyAssetIdsFromClip(
  clip: TimelineClip,
  proxyAssetIds: Set<string>,
): void {
  if (clip.type !== "composite") {
    return;
  }

  if (clip.proxyAssetId) {
    proxyAssetIds.add(clip.proxyAssetId);
  }

  clip.content.clips.forEach((contentClip) => {
    collectCompositeProxyAssetIdsFromClip(contentClip, proxyAssetIds);
  });
}

export function clipReferencesAssetId(
  clip: TimelineClip,
  assetId: string,
): boolean {
  if (isAssetBackedClip(clip) && clip.assetId === assetId) {
    return true;
  }

  if (clip.type !== "composite") {
    return false;
  }

  return (
    clip.proxyAssetId === assetId ||
    clip.content.clips.some((contentClip) =>
      clipReferencesAssetId(contentClip, assetId),
    )
  );
}

export function collectUnusedCompositeProxyAssetIds(
  clips: readonly TimelineClip[],
  candidateAssetIds: Iterable<string>,
): Set<string> {
  const unusedAssetIds = new Set([...candidateAssetIds].filter(Boolean));
  if (unusedAssetIds.size === 0) {
    return unusedAssetIds;
  }

  for (const clip of clips) {
    for (const assetId of [...unusedAssetIds]) {
      if (clipReferencesAssetId(clip, assetId)) {
        unusedAssetIds.delete(assetId);
      }
    }
    if (unusedAssetIds.size === 0) {
      break;
    }
  }

  return unusedAssetIds;
}

function createDefaultFitModeTransform(): ClipTransform {
  return {
    id: crypto.randomUUID(),
    type: "fitMode",
    isEnabled: true,
    parameters: {
      fitMode: useProjectStore.getState().config.fitMode,
    },
  };
}

export function withTimelineClipDefaults(clip: TimelineClip): TimelineClip {
  if (clip.type === "mask") {
    return clip;
  }

  const normalizedComponents = normalizeComponentsMaskComposite(clip.components);
  const baseClip: StandardTimelineClip =
    normalizedComponents === clip.components
      ? clip
      : {
          ...clip,
          components: normalizedComponents,
        };

  if (isTextClip(baseClip)) {
    const textData = resolveTextClipData(baseClip.textData);
    return {
      ...baseClip,
      name: deriveTextClipName(textData.content),
      textData,
    };
  }

  // Composites render through a project-sized proxy video, so they get the same
  // default fit-mode layout as a video/image clip.
  if (
    clip.type !== "video" &&
    clip.type !== "image" &&
    clip.type !== "composite"
  ) {
    return baseClip;
  }

  const hasFitModeTransform = (baseClip.transformations ?? []).some(
    (transform) => transform.type === "fitMode",
  );
  if (hasFitModeTransform) {
    return baseClip;
  }

  return {
    ...baseClip,
    transformations: [
      createDefaultFitModeTransform(),
      ...structuredClone(baseClip.transformations || []),
    ],
  };
}

export function duplicateTimelineClip(
  clip: TimelineClip,
  allClips: TimelineClip[],
): TimelineClip {
  const [parent] = cloneClipWithMasks(clip, allClips);
  return parent;
}

export function copySelectedClips(
  selectedClipIds: string[],
  clips: TimelineClip[],
  tracks: TimelineTrack[],
): TimelineClip[] {
  if (selectedClipIds.length === 0) {
    return [];
  }

  const selectedSet = new Set(selectedClipIds);
  const selectedClips = clips.filter(
    (clip) => selectedSet.has(clip.id) && clip.type !== "mask",
  );
  if (selectedClips.length === 0) {
    return [];
  }

  const trackIndexById = new Map(
    tracks.map((track, index) => [track.id, index] as const),
  );

  const orderedSelection = [...selectedClips].sort((left, right) => {
    const trackDelta =
      (trackIndexById.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
      (trackIndexById.get(right.trackId) ?? Number.MAX_SAFE_INTEGER);

    if (trackDelta !== 0) return trackDelta;
    if (left.start !== right.start) return left.start - right.start;
    return left.id.localeCompare(right.id);
  });

  const copiedClips: TimelineClip[] = [];
  orderedSelection.forEach((clip) => {
    copiedClips.push(...cloneClipWithMasks(clip, clips));
  });
  return copiedClips;
}

export function addClipToDraft(
  draft: TimelineModelState,
  clip: TimelineClip,
): void {
  const clipWithDefaults = withTimelineClipDefaults(clip);
  const targetTrack = draft.tracks.find(
    (track) => track.id === clipWithDefaults.trackId,
  );
  if (targetTrack && !targetTrack.type) {
    targetTrack.type = getTrackTypeFromClipType(clipWithDefaults.type);
  }

  draft.clips.push(clipWithDefaults);
  maybeTrimAndPadTracks(draft);
}

export function addTrackToDraft(draft: TimelineModelState): void {
  draft.tracks.push(createNewTrack(`Track ${draft.tracks.length + 1}`));
}

export function insertTrackIntoDraft(
  draft: TimelineModelState,
  index: number,
  newTrack: TimelineTrack,
): void {
  const safeIndex = Math.max(0, Math.min(index, draft.tracks.length));
  draft.tracks.splice(safeIndex, 0, newTrack);
}

export function pasteCopiedClipsAboveDraft(
  draft: TimelineModelState,
  copiedClips: TimelineClip[],
): string[] {
  const parentCopies = copiedClips.filter((clip) => clip.type !== "mask");
  if (parentCopies.length === 0) {
    return [];
  }

  const maskCopiesByParent = new Map<string, TimelineClip[]>();
  parentCopies.forEach((parent) => {
    const maskChildIds = new Set(getChildMaskClipIds(parent));
    if (maskChildIds.size === 0) return;
    const masks = copiedClips.filter((clip) => maskChildIds.has(clip.id));
    if (masks.length > 0) {
      maskCopiesByParent.set(parent.id, masks);
    }
  });

  const groupsBySourceTrack = new Map<string, TimelineClip[]>();
  parentCopies.forEach((clip) => {
    const group = groupsBySourceTrack.get(clip.trackId) || [];
    group.push(clip);
    groupsBySourceTrack.set(clip.trackId, group);
  });

  const pastedClipIds: string[] = [];
  const initialTrackIndexById = new Map(
    draft.tracks.map((track, index) => [track.id, index] as const),
  );

  const sourceTrackIdsByPriority = [...groupsBySourceTrack.keys()].sort(
    (left, right) =>
      (initialTrackIndexById.get(right) ?? Number.MIN_SAFE_INTEGER) -
      (initialTrackIndexById.get(left) ?? Number.MIN_SAFE_INTEGER),
  );

  sourceTrackIdsByPriority.forEach((sourceTrackId) => {
    const clipsInGroup = groupsBySourceTrack.get(sourceTrackId) || [];
    if (clipsInGroup.length === 0) return;

    const currentTrackIndex = draft.tracks.findIndex(
      (track) => track.id === sourceTrackId,
    );
    if (currentTrackIndex === -1) return;

    const aboveTrack =
      currentTrackIndex > 0 ? draft.tracks[currentTrackIndex - 1] : null;

    const canUseAboveTrack =
      !!aboveTrack &&
      clipsInGroup.every((clip) => {
        if (
          aboveTrack.type &&
          aboveTrack.type !== getTrackTypeFromClipType(clip.type)
        ) {
          return false;
        }

        return (
          resolveCollision(
            clip.id,
            clip.start,
            clip.timelineDuration,
            aboveTrack.id,
            draft.clips,
          ) === clip.start
        );
      });

    const targetTrackId =
      canUseAboveTrack && aboveTrack
        ? aboveTrack.id
        : (() => {
            const inserted = createNewTrack("New Track");
            draft.tracks.splice(Math.max(currentTrackIndex, 0), 0, inserted);
            return inserted.id;
          })();

    clipsInGroup.forEach((clip) => {
      const pastedClip = cloneTimelineClip(clip, crypto.randomUUID());
      pastedClip.trackId = targetTrackId;
      pastedClip.start = clip.start;
      if (pastedClip.type === "composite") {
        pastedClip.proxyAssetId = undefined;
        pastedClip.proxyContentHash = undefined;
      }

      const targetTrack = draft.tracks.find((track) => track.id === targetTrackId);
      if (targetTrack && !targetTrack.type) {
        targetTrack.type = getTrackTypeFromClipType(pastedClip.type);
      }

      const pastedMasks = (maskCopiesByParent.get(clip.id) || []).map((maskClip) => {
        const parsed = parseMaskClipId(maskClip.id);
        const maskLocalId = parsed?.maskId ?? crypto.randomUUID();
        const clonedMask = {
          ...cloneTimelineClip(
            maskClip,
            makeMaskClipId(pastedClip.id, maskLocalId),
          ),
          parentClipId: pastedClip.id,
          trackId: pastedClip.trackId,
        };
        return syncMaskInheritedSpeed(
          syncMaskTiming(clonedMask, pastedClip),
          pastedClip,
        );
      });

      setChildMaskClipIds(pastedClip, pastedMasks.map((mask) => mask.id));
      draft.clips.push(pastedClip);
      draft.clips.push(...pastedMasks);
      pastedClipIds.push(pastedClip.id);
    });
  });

  maybeTrimAndPadTracks(draft);
  return pastedClipIds;
}

export function splitClipInDraft(
  draft: TimelineModelState,
  clipId: string,
  splitTime: number,
): string | null {
  const clip = draft.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return null;

  if (splitTime <= clip.start || splitTime >= clip.start + clip.timelineDuration) {
    console.warn("[Store] Split time outside clip bounds");
    return null;
  }

  const leftDuration = splitTime - clip.start;
  const leftDelta = leftDuration - clip.timelineDuration;
  const leftUpdates = getResizedClipRight(clip, leftDelta);

  const cloned = cloneClipWithMasks(clip, draft.clips);
  const [rightClip, ...rightMasks] = cloned;

  const rightDelta = splitTime - clip.start;
  const rightUpdates = getResizedClipLeft(rightClip, rightDelta);
  Object.assign(rightClip, rightUpdates);

  const leftParent = { ...clip, ...leftUpdates } as TimelineClip;

  let updatedClips: TimelineClip[] = draft.clips.flatMap((candidate) => {
    if (candidate.id === clipId) {
      return [leftParent, rightClip, ...rightMasks];
    }
    return [candidate];
  });

  updatedClips = propagateParentToMasks(updatedClips, leftParent);
  updatedClips = propagateParentToMasks(updatedClips, rightClip);
  draft.clips = updatedClips;

  maybeTrimAndPadTracks(draft);
  return rightClip.id;
}

export function planTimelineRemoval(
  clips: TimelineClip[],
  clipIds: Iterable<string>,
): TimelineRemovalPlan {
  const { clipIdsToRemove, sam2MaskAssetIdsToDelete } = collectClipRemovalPlan(
    clips,
    clipIds,
  );
  const brushMaskClipIdsToDispose = clips
    .filter(
      (clip): clip is MaskTimelineClip =>
        clipIdsToRemove.has(clip.id) &&
        clip.type === "mask" &&
        clip.maskType === "brush",
    )
    .map((clip) => clip.id);
  const compositeProxyCandidates = new Set<string>();
  for (const clip of clips) {
    if (clipIdsToRemove.has(clip.id)) {
      collectCompositeProxyAssetIdsFromClip(clip, compositeProxyCandidates);
    }
  }
  const remainingClips = clips.filter((clip) => !clipIdsToRemove.has(clip.id));
  const compositeProxyAssetIdsToDelete = collectUnusedCompositeProxyAssetIds(
    remainingClips,
    compositeProxyCandidates,
  );

  return {
    clipIdsToRemove,
    brushMaskClipIdsToDispose,
    sam2MaskAssetIdsToDelete,
    compositeProxyAssetIdsToDelete,
  };
}

export function removeClipIdsFromDraft(
  draft: TimelineModelState,
  clipIdsToRemove: Set<string>,
): void {
  removeClipsFromDraft(draft, clipIdsToRemove, maybeTrimAndPadTracks);
}

function syncTrackTypesFromClips(draft: TimelineModelState): void {
  const nextTrackTypeById = new Map<string, TimelineTrack["type"] | undefined>(
    draft.tracks.map((track) => [track.id, undefined]),
  );

  draft.clips.forEach((clip) => {
    if (clip.type === "mask") {
      return;
    }

    nextTrackTypeById.set(clip.trackId, getTrackTypeFromClipType(clip.type));
  });

  draft.tracks = draft.tracks.map((track) => {
    const nextType = nextTrackTypeById.get(track.id);
    return track.type === nextType ? track : { ...track, type: nextType };
  });
}

export function moveClipsInDraft(
  draft: TimelineModelState,
  moves: TimelineClipMove[],
): void {
  const clipsById = new Map(
    draft.clips.map((clip) => [clip.id, clip] as const),
  );
  const normalizedMoves = new Map<string, { start: number; trackId: string }>();

  moves.forEach((move) => {
    const clip = clipsById.get(move.clipId);
    if (!clip || clip.type === "mask") {
      return;
    }

    const nextStart = Math.round(Math.max(0, move.start));
    const nextTrackId = move.trackId ?? clip.trackId;

    if (nextStart === clip.start && nextTrackId === clip.trackId) {
      return;
    }

    normalizedMoves.set(move.clipId, {
      start: nextStart,
      trackId: nextTrackId,
    });
  });

  if (normalizedMoves.size === 0) {
    return;
  }

  draft.clips = draft.clips.map((candidate) => {
    const move = (() => {
      if (candidate.type !== "mask") {
        return normalizedMoves.get(candidate.id);
      }

      return candidate.parentClipId
        ? normalizedMoves.get(candidate.parentClipId)
        : undefined;
    })();

    if (!move) {
      return candidate;
    }

    if (candidate.start === move.start && candidate.trackId === move.trackId) {
      return candidate;
    }

    return {
      ...candidate,
      start: move.start,
      trackId: move.trackId,
    };
  });

  syncTrackTypesFromClips(draft);
  maybeTrimAndPadTracks(draft);
}

export function replaceClipAssetInDraft(
  draft: TimelineModelState,
  clipId: string,
  asset: Asset,
): void {
  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== clipId || clip.type === "mask") {
      return clip;
    }

    if (clip.type !== asset.type) {
      return clip;
    }

    return {
      ...clip,
      assetId: asset.id,
      name: asset.name,
    };
  });
}

export function updateClipPositionInDraft(
  draft: TimelineModelState,
  id: string,
  newStartTicks: number,
  newTrackId?: string,
): void {
  moveClipsInDraft(draft, [
    {
      clipId: id,
      start: newStartTicks,
      trackId: newTrackId,
    },
  ]);
}

function applyClipShape(
  clip: TimelineClip,
  shape: TimelineClipShape,
): TimelineClip {
  return {
    ...clip,
    start: shape.start !== undefined ? Math.round(shape.start) : clip.start,
    timelineDuration:
      shape.timelineDuration !== undefined
        ? Math.round(shape.timelineDuration)
        : clip.timelineDuration,
    offset: shape.offset !== undefined ? Math.round(shape.offset) : clip.offset,
    transformedDuration:
      shape.transformedDuration !== undefined
        ? Math.round(shape.transformedDuration)
        : clip.transformedDuration,
    transformedOffset:
      shape.transformedOffset !== undefined
        ? Math.round(shape.transformedOffset)
        : clip.transformedOffset,
    croppedSourceDuration:
      shape.croppedSourceDuration !== undefined
        ? Math.round(shape.croppedSourceDuration)
        : clip.croppedSourceDuration,
  };
}

export function updateClipShapeInDraft(
  draft: TimelineModelState,
  id: string,
  shape: TimelineClipShape,
): void {
  let updatedParent: TimelineClip | null = null;

  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== id) return clip;

    const updated = applyClipShape(clip, shape);

    updatedParent = updated;
    return updated;
  });

  if (updatedParent) {
    draft.clips = propagateParentToMasks(draft.clips, updatedParent);
  }
}

export function updateTextClipDataInDraft(
  draft: TimelineModelState,
  clipId: string,
  updates: Partial<TextClipData>,
): void {
  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== clipId || clip.type !== "text") {
      return clip;
    }

    const textData = resolveTextClipData({
      ...clip.textData,
      ...updates,
    });

    return {
      ...clip,
      name: deriveTextClipName(textData.content),
      textData,
    };
  });
}

export function updateClipDurationInDraft(
  draft: TimelineModelState,
  id: string,
  newDurationTicks: number,
): void {
  let updatedParent: TimelineClip | null = null;

  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== id) return clip;

    const updated = {
      ...clip,
      timelineDuration: Math.round(
        Math.max(TICKS_PER_SECOND / 60, newDurationTicks),
      ),
    };

    updatedParent = updated;
    return updated;
  });

  if (updatedParent) {
    draft.clips = propagateParentToMasks(draft.clips, updatedParent);
  }
}

export function addClipTransformToDraft(
  draft: TimelineModelState,
  clipId: string,
  effect: ClipTransform,
): void {
  draft.clips = draft.clips.map((clip) =>
    clip.id === clipId
      ? { ...clip, transformations: [...(clip.transformations || []), effect] }
      : clip,
  );

  if (isInheritedTransformType(effect.type)) {
    const parent = draft.clips.find((clip) => clip.id === clipId);
    if (parent && parent.type !== "mask") {
      draft.clips = propagateParentToMasks(draft.clips, parent);
    }
  }
}

export function updateClipTransformInDraft(
  draft: TimelineModelState,
  clipId: string,
  effectId: string,
  updates: Partial<Omit<ClipTransform, "id" | "type">>,
): void {
  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== clipId) return clip;

    return {
      ...clip,
      transformations: clip.transformations.map((effect) =>
        effect.id === effectId ? { ...effect, ...updates } : effect,
      ),
    };
  });

  const parent = draft.clips.find((clip) => clip.id === clipId);
  if (parent && parent.type !== "mask") {
    const transform = parent.transformations.find((candidate) => candidate.id === effectId);
    if (transform && isInheritedTransformType(transform.type)) {
      draft.clips = propagateParentToMasks(draft.clips, parent);
    }
  }
}

export function setClipTransformsInDraft(
  draft: TimelineModelState,
  clipId: string,
  transforms: ClipTransform[],
): void {
  setClipTransformsAndShapeInDraft(draft, clipId, transforms);
}

export function setClipTransformsAndShapeInDraft(
  draft: TimelineModelState,
  clipId: string,
  transforms: ClipTransform[],
  shape?: TimelineClipShape,
): void {
  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== clipId) {
      return clip;
    }

    const withTransforms = { ...clip, transformations: transforms };
    return shape ? applyClipShape(withTransforms, shape) : withTransforms;
  });

  const updatedParent = draft.clips.find((clip) => clip.id === clipId);
  if (updatedParent && updatedParent.type !== "mask") {
    draft.clips = propagateParentToMasks(draft.clips, updatedParent);
  }
}

export function setClipMaskCompositeTransformsInDraft(
  draft: TimelineModelState,
  clipId: string,
  transforms: ClipTransform[],
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip) return;

  updateMaskCompositionOnDraft(clip, (current) => {
    const algebra = resolveMaskCompositionAlgebra(current);
    const normalized = syncMaskEdgeTransformsToAlgebra(transforms, algebra);
    if (
      current.expression === undefined &&
      current.algebra === undefined &&
      normalized.length === 0
    ) {
      return null;
    }

    const nextParams = {
      ...current,
      algebra,
      compositeTransformations: normalized,
    };
    return isMaskCompositionComponentMeaningful(nextParams) ? nextParams : null;
  });
}

export function setClipMaskCompositionAlgebraInDraft(
  draft: TimelineModelState,
  clipId: string,
  algebra: MaskCompositionAlgebra,
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip) return;

  updateMaskCompositionOnDraft(clip, (current) => {
    const nextParams = {
      ...current,
      algebra,
      compositeTransformations: syncMaskEdgeTransformsToAlgebra(
        current.compositeTransformations,
        algebra,
      ),
    };
    return isMaskCompositionComponentMeaningful(nextParams) ? nextParams : null;
  });
}

export function setClipMaskBooleanExpressionInDraft(
  draft: TimelineModelState,
  clipId: string,
  expression: MaskBooleanExpression | null,
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip) return;

  updateMaskCompositionOnDraft(clip, (current) => ({
    ...current,
    expression: expression ? structuredClone(expression) : null,
  }));
}

export function removeClipTransformFromDraft(
  draft: TimelineModelState,
  clipId: string,
  effectId: string,
): void {
  const clip = draft.clips.find((candidate) => candidate.id === clipId);
  const removedTransform = clip?.transformations.find(
    (effect) => effect.id === effectId,
  );

  draft.clips = draft.clips.map((candidate) =>
    candidate.id === clipId
      ? {
          ...candidate,
          transformations: candidate.transformations.filter(
            (effect) => effect.id !== effectId,
          ),
        }
      : candidate,
  );

  if (
    removedTransform &&
    isInheritedTransformType(removedTransform.type) &&
    clip &&
    clip.type !== "mask"
  ) {
    const parent = draft.clips.find((candidate) => candidate.id === clipId);
    if (parent) {
      draft.clips = propagateParentToMasks(draft.clips, parent);
    }
  }
}

export function addClipMaskToDraft(
  draft: TimelineModelState,
  clipId: string,
  mask: ClipMask,
): void {
  const parent = draft.clips.find((clip) => clip.id === clipId);
  if (!parent || parent.type === "mask") return;

  const existingMaskClips = getOrderedChildMaskClips(draft.clips, parent);

  const maskClip = maskToClip(parent, mask);
  maskClip.name = `Mask ${existingMaskClips.length + 1}`;
  draft.clips.push(maskClip);
  addMaskClipComponent(parent, maskClip.id);

  const maskLocalId = getMaskLocalId(maskClip);
  if (!maskLocalId) {
    return;
  }

  const resolved = resolveMaskBooleanExpression(parent, existingMaskClips);
  const nextExpression = appendMaskBooleanExpression(resolved, maskLocalId);
  updateMaskCompositionOnDraft(parent, (current) => ({
    ...current,
    expression: nextExpression,
  }));
}

export function duplicateClipMaskInDraft(
  draft: TimelineModelState,
  clipId: string,
  maskId: string,
): string | null {
  const parent = draft.clips.find(
    (clip): clip is StandardTimelineClip =>
      clip.id === clipId && isNonMaskTimelineClip(clip),
  );
  if (!parent) return null;

  const sourceMaskClipId = makeMaskClipId(clipId, maskId);
  const sourceMask = draft.clips.find(
    (clip): clip is MaskTimelineClip =>
      clip.id === sourceMaskClipId && clip.type === "mask",
  );
  if (!sourceMask) return null;

  const orderedMaskClips = getOrderedChildMaskClips(draft.clips, parent);
  const sourceIndex = orderedMaskClips.findIndex(
    (maskClip) => maskClip.id === sourceMaskClipId,
  );
  const nextLocalId = `mask_${crypto.randomUUID()}`;
  const nextMaskClipId = makeMaskClipId(clipId, nextLocalId);
  const storedSourceName = sourceMask.name.trim();
  const sourceName =
    storedSourceName && storedSourceName !== `Mask ${maskId}`
      ? storedSourceName
      : sourceIndex >= 0
        ? `Mask ${sourceIndex + 1}`
        : "Mask";
  const duplicatedMask: MaskTimelineClip = {
    ...structuredClone(sourceMask),
    id: nextMaskClipId,
    name: `${sourceName} copy`,
    parentClipId: clipId,
    trackId: parent.trackId,
  };

  draft.clips.push(duplicatedMask);

  const currentMaskClipIds = getChildMaskClipIds(parent);
  const insertIndex = sourceIndex >= 0 ? sourceIndex + 1 : currentMaskClipIds.length;
  const nextMaskClipIds = [
    ...currentMaskClipIds.slice(0, insertIndex),
    nextMaskClipId,
    ...currentMaskClipIds.slice(insertIndex),
  ];
  setChildMaskClipIds(parent, nextMaskClipIds);

  const resolved = resolveMaskBooleanExpression(parent, orderedMaskClips);
  updateMaskCompositionOnDraft(parent, (current) => ({
    ...current,
    expression: appendMaskBooleanExpression(resolved, nextLocalId),
  }));

  return nextLocalId;
}

export function updateClipMaskInDraft(
  draft: TimelineModelState,
  clipId: string,
  maskId: string,
  updates: TimelineMaskUpdate,
): void {
  const maskClipId = makeMaskClipId(clipId, maskId);
  const maskClip = draft.clips.find((clip) => clip.id === maskClipId);

  if (!maskClip || maskClip.type !== "mask") return;

  if (updates.name !== undefined) {
    maskClip.name = updates.name;
  }

  if (updates.maskMode !== undefined) {
    maskClip.maskMode = updates.maskMode;
  }

  if (updates.maskInverted !== undefined) {
    maskClip.maskInverted = updates.maskInverted;
  }

  if (updates.sam2GrowAmount !== undefined) {
    maskClip.sam2GrowAmount = updates.sam2GrowAmount;
  }

  if (updates.maskParameters !== undefined) {
    maskClip.maskParameters = {
      ...maskClip.maskParameters,
      ...updates.maskParameters,
    };
  }

  if (updates.maskPoints !== undefined) {
    maskClip.maskPoints = structuredClone(updates.maskPoints);
  }

  if (updates.sam2MaskAssetId !== undefined) {
    maskClip.sam2MaskAssetId = updates.sam2MaskAssetId;
  }

  if (updates.sam2GeneratedPointsHash !== undefined) {
    maskClip.sam2GeneratedPointsHash = updates.sam2GeneratedPointsHash;
  }

  if (updates.sam2LastGeneratedAt !== undefined) {
    maskClip.sam2LastGeneratedAt = updates.sam2LastGeneratedAt;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "brushMaskAssetId")) {
    maskClip.brushMaskAssetId = updates.brushMaskAssetId ?? undefined;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "brushPaintedBounds")) {
    maskClip.brushPaintedBounds = updates.brushPaintedBounds ?? undefined;
  }

  if (updates.activeRange !== undefined) {
    if (updates.activeRange === null) {
      maskClip.activeRange = undefined;
    } else {
      const start = Math.min(
        updates.activeRange.startSourceTicks,
        updates.activeRange.endSourceTicks,
      );
      const end = Math.max(
        updates.activeRange.startSourceTicks,
        updates.activeRange.endSourceTicks,
      );
      maskClip.activeRange = {
        startSourceTicks: start,
        endSourceTicks: end,
      };
    }
  }

  if (updates.transformations !== undefined) {
    const parent = draft.clips.find((clip) => clip.id === clipId);
    if (parent) {
      maskClip.transformations = buildMaskClipTransformations(
        updates.transformations,
        parent,
      );
    } else {
      maskClip.transformations = updates.transformations;
    }
  }
}

export function addClipComponentToDraft(
  draft: TimelineModelState,
  clipId: string,
  component: Component,
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip) return;

  clip.components = [...(clip.components ?? []), component];
}

export function updateClipComponentInDraft(
  draft: TimelineModelState,
  clipId: string,
  componentId: string,
  updater: (component: Component) => Component,
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip?.components) return;

  clip.components = clip.components.map((component) =>
    component.id === componentId ? updater(component) : component,
  );
}

export function removeClipComponentFromDraft(
  draft: TimelineModelState,
  clipId: string,
  componentId: string,
): void {
  const clip = draft.clips.find(
    (candidate): candidate is StandardTimelineClip =>
      candidate.id === clipId && isNonMaskTimelineClip(candidate),
  );
  if (!clip?.components) return;

  const next = clip.components.filter((component) => component.id !== componentId);
  clip.components = next.length > 0 ? next : undefined;
}

export function toggleTrackVisibilityInDraft(
  draft: TimelineModelState,
  trackId: string,
): void {
  draft.tracks = draft.tracks.map((track) =>
    track.id === trackId ? { ...track, isVisible: !track.isVisible } : track,
  );
}

export function toggleTrackMuteInDraft(
  draft: TimelineModelState,
  trackId: string,
): void {
  draft.tracks = draft.tracks.map((track) =>
    track.id === trackId ? { ...track, isMuted: !track.isMuted } : track,
  );
}

export function toggleClipMuteInDraft(
  draft: TimelineModelState,
  clipId: string,
): void {
  draft.clips = draft.clips.map((clip) => {
    if (clip.id !== clipId || clip.type === "mask") return clip;
    return { ...clip, isMuted: !clip.isMuted };
  });
}

export function trimAndPadTracksInDraft(draft: TimelineModelState): void {
  maybeTrimAndPadTracks(draft);
}

export function getTimelineClipsAtTime(
  clips: TimelineClip[],
  time: number,
): TimelineClip[] {
  return clips.filter(
    (clip) =>
      clip.type !== "mask" &&
      clip.start <= time &&
      clip.start + clip.timelineDuration > time,
  );
}
