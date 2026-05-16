import type {
  MaskBooleanExpression,
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import {
  isAssetBackedClip,
  isNonMaskTimelineClip,
} from "../../../types/TimelineTypes";
import { resolveMaskBooleanExpression } from "../../masks/model/maskBooleanExpression";
import { getChildMaskClipIds } from "../model/maskClipModel";

export interface TimelineClipCollectionState {
  clips: TimelineClip[];
}

export interface TimelineSelectionState extends TimelineClipCollectionState {
  selectedClipIds: string[];
}

function findTimelineClipById(
  clips: readonly TimelineClip[],
  clipId: string | null | undefined,
): TimelineClip | undefined {
  if (!clipId) {
    return undefined;
  }

  return clips.find((clip) => clip.id === clipId);
}

function matchesTrackSelection(
  clip: TimelineClip,
  trackId: string,
  includeMasks: boolean,
): boolean {
  return clip.trackId === trackId && (includeMasks || clip.type !== "mask");
}

function computeTimelineDuration(clips: readonly TimelineClip[]): number {
  return clips.reduce(
    (maxDuration, clip) =>
      Math.max(maxDuration, clip.start + clip.timelineDuration),
    0,
  );
}

export function selectTimelineClipById(
  state: TimelineClipCollectionState,
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return findTimelineClipById(state.clips, clipId);
}

export function selectPrimaryActiveClip(
  state: TimelineSelectionState,
): TimelineClip | undefined {
  const primaryActiveClipId = state.selectedClipIds[0];
  return selectTimelineClipById(state, primaryActiveClipId);
}

export function selectTimelineClipsForTrack(
  state: TimelineClipCollectionState,
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return state.clips.filter((clip) =>
    matchesTrackSelection(clip, trackId, includeMasks),
  );
}

export function selectTimelineDuration(
  state: TimelineClipCollectionState,
): number {
  return computeTimelineDuration(state.clips);
}

export function selectTimelineClipCountForAsset(
  state: TimelineClipCollectionState,
  assetId: string | null | undefined,
): number {
  if (!assetId) {
    return 0;
  }

  return state.clips.reduce(
    (count, clip) =>
      count + (isAssetBackedClip(clip) && clip.assetId === assetId ? 1 : 0),
    0,
  );
}

export function selectMaskClipsForParent(
  state: TimelineClipCollectionState,
  parentClipId: string,
): MaskTimelineClip[] {
  const parent = state.clips.find((clip) => clip.id === parentClipId);
  if (!parent) return [];
  const maskChildIds = getChildMaskClipIds(parent);
  if (maskChildIds.length === 0) return [];
  const clipById = new Map(state.clips.map((clip) => [clip.id, clip] as const));
  return maskChildIds
    .map((maskChildId) => clipById.get(maskChildId))
    .filter((clip): clip is MaskTimelineClip => !!clip && clip.type === "mask");
}

export function selectResolvedMaskBooleanExpressionForParent(
  state: TimelineClipCollectionState,
  parentClipId: string,
): MaskBooleanExpression | null {
  const parent = state.clips.find(
    (clip): clip is StandardTimelineClip =>
      clip.id === parentClipId && isNonMaskTimelineClip(clip),
  );
  if (!parent) {
    return null;
  }

  return resolveMaskBooleanExpression(
    parent,
    selectMaskClipsForParent(state, parentClipId),
  );
}
