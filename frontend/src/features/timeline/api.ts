import { useShallow } from "zustand/react/shallow";
import type { TimelineClip, TimelineTrack } from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import {
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
} from "./selectors/timelineSelectors";
import { useTimelineStore } from "./useTimelineStore";
import { useProjectStore } from "../project/useProjectStore";

type TimelineStoreState = ReturnType<typeof useTimelineStore.getState>;

export {
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
};

export function useTimelineClip(
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return useTimelineStore((state) => selectTimelineClipById(state, clipId));
}

export function usePrimaryActiveClip(): TimelineClip | undefined {
  return useTimelineStore(selectPrimaryActiveClip);
}

export function useTimelineClips(): TimelineClip[] {
  return useTimelineStore(useShallow((state) => state.clips));
}

export function useTimelineTracks(): TimelineTrack[] {
  return useTimelineStore(useShallow((state) => state.tracks));
}

export function useSelectedTimelineClipIds(): string[] {
  return useTimelineStore(useShallow((state) => state.selectedClipIds));
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
  const fps = useProjectStore((state) => state.config.fps);
  return useTimelineStore((state) => selectTimelineDuration(state, fps));
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

export function getTimelineTracks(): TimelineTrack[] {
  return useTimelineStore.getState().tracks;
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
  return selectTimelineDuration(
    useTimelineStore.getState(),
    useProjectStore.getState().config.fps,
  );
}

export function getTimelineClipCountForAsset(
  assetId: string | null | undefined,
): number {
  return selectTimelineClipCountForAsset(useTimelineStore.getState(), assetId);
}

export function replaceTimelineSnapshot(
  snapshot: TimelineSnapshot | null,
): void {
  useTimelineStore.getState().replaceTimelineSnapshot(snapshot);
}

export async function flushPendingTimelinePersistence(): Promise<void> {
  await useTimelineStore.getState().flushPendingPersistence();
}

export type { TimelineStoreState };
