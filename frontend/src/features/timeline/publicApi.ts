import { useShallow } from "zustand/react/shallow";
import type { TimelineClip } from "../../types/TimelineTypes";
import { useTimelineStore } from "./useTimelineStore";

type TimelineStoreState = ReturnType<typeof useTimelineStore.getState>;

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
  state: TimelineStoreState,
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return findTimelineClipById(state.clips, clipId);
}

export function selectPrimaryActiveClip(
  state: TimelineStoreState,
): TimelineClip | undefined {
  const primaryActiveClipId = state.selectedClipIds[0];
  return selectTimelineClipById(state, primaryActiveClipId);
}

export function selectTimelineClipsForTrack(
  state: TimelineStoreState,
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return state.clips.filter((clip) =>
    matchesTrackSelection(clip, trackId, includeMasks),
  );
}

export function selectTimelineDuration(state: TimelineStoreState): number {
  return computeTimelineDuration(state.clips);
}

export function selectTimelineClipCountForAsset(
  state: TimelineStoreState,
  assetId: string | null | undefined,
): number {
  if (!assetId) {
    return 0;
  }

  return state.clips.reduce(
    (count, clip) => count + (clip.assetId === assetId ? 1 : 0),
    0,
  );
}

export function useTimelineClip(
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return useTimelineStore((state) => selectTimelineClipById(state, clipId));
}

export function usePrimaryActiveClip(): TimelineClip | undefined {
  return useTimelineStore(selectPrimaryActiveClip);
}

export function useTimelineClipsForTrack(
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return useTimelineStore(
    useShallow((state) =>
      selectTimelineClipsForTrack(state, trackId, includeMasks),
    ),
  );
}

export function useTimelineDuration(): number {
  return useTimelineStore(selectTimelineDuration);
}

export function useTimelineClipCountForAsset(
  assetId: string | null | undefined,
): number {
  return useTimelineStore((state) =>
    selectTimelineClipCountForAsset(state, assetId),
  );
}

export function getTimelineClips(): TimelineClip[] {
  return useTimelineStore.getState().clips;
}

export function getTimelineClipById(
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return selectTimelineClipById(useTimelineStore.getState(), clipId);
}

export function getPrimaryActiveClip(): TimelineClip | undefined {
  return selectPrimaryActiveClip(useTimelineStore.getState());
}

export function getTimelineClipsForTrack(
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return selectTimelineClipsForTrack(
    useTimelineStore.getState(),
    trackId,
    includeMasks,
  );
}

export function getTimelineDuration(): number {
  return selectTimelineDuration(useTimelineStore.getState());
}

export function getTimelineClipCountForAsset(
  assetId: string | null | undefined,
): number {
  return selectTimelineClipCountForAsset(useTimelineStore.getState(), assetId);
}
