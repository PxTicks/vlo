import { useShallow } from "zustand/react/shallow";
import type { TimelineClip } from "../../types/TimelineTypes";
import {
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
} from "./selectors/timelineSelectors";
import { useTimelineStore } from "./useTimelineStore";

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

export type { TimelineStoreState };
