import { create } from "zustand";
import type {
  CompositeContent,
  CompositeTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import { useProjectStore } from "../project/useProjectStore";
import { playbackClock } from "../player/services/PlaybackClock";
import { TICKS_PER_SECOND } from "../timeline/constants";
import { createDefaultTimelineSnapshot } from "../timeline/model/timelineTrackModel";
import { useTimelineStore } from "../timeline/useTimelineStore";
import { scheduleCompositeProxyRender } from "./services/renderCompositeProxyForClip";
import { createCompositeTimelineClip } from "./utils/createCompositeClip";

interface CompositeTimelineFrame {
  previousSnapshot: TimelineSnapshot;
  ownerClipId: string | null;
  insertStartTick: number;
  name: string;
}

interface CompositeRenderJob {
  clipId: string;
  content: CompositeContent;
}

interface CompositeTimelineState {
  stack: CompositeTimelineFrame[];
  isBusy: boolean;
  lastError: string | null;
  startBlankSubtimeline: () => boolean;
  openCompositeClip: (clipId: string) => boolean;
  exitToMainTimeline: () => Promise<boolean>;
  clearLastError: () => void;
}

function cloneTimelineSnapshot(snapshot: TimelineSnapshot): TimelineSnapshot {
  return {
    tracks: structuredClone(snapshot.tracks),
    clips: structuredClone(snapshot.clips),
  };
}

function getCurrentTimelineSnapshot(): TimelineSnapshot {
  const { tracks, clips } = useTimelineStore.getState();
  return {
    tracks: structuredClone(tracks),
    clips: structuredClone(clips),
  };
}

function getSnapshotForCompositeClip(clip: CompositeTimelineClip): TimelineSnapshot {
  return {
    tracks:
      clip.content.tracks && clip.content.tracks.length > 0
        ? structuredClone(clip.content.tracks)
        : createDefaultTimelineSnapshot().tracks,
    clips: structuredClone(clip.content.clips),
  };
}

function getCurrentCompositeContent(): CompositeContent {
  const { clips, tracks } = useTimelineStore.getState();
  const durationTicks = inferTimelineDuration(clips);

  return {
    clips: structuredClone(clips),
    tracks: structuredClone(tracks),
    durationTicks,
    fps: useProjectStore.getState().config.fps,
    frameStep: 1,
  };
}

function inferTimelineDuration(clips: TimelineClip[]): number {
  const maxClipEnd = clips.reduce(
    (max, clip) => Math.max(max, clip.start + clip.timelineDuration),
    0,
  );
  return Math.max(TICKS_PER_SECOND, maxClipEnd);
}

function pickCompositeTrackId(tracks: TimelineTrack[]): string {
  const visualTrack = tracks.find(
    (track) => track.type === "visual" || track.type === undefined,
  );
  if (visualTrack) return visualTrack.id;
  if (tracks[0]) return tracks[0].id;
  return useTimelineStore.getState().insertTrack(0);
}

function isEmptyNewSceneContent(content: CompositeContent): boolean {
  return content.clips.length === 0;
}

function saveContentToRestoredTimeline(
  frame: CompositeTimelineFrame,
  content: CompositeContent,
): CompositeTimelineClip | null {
  const timeline = useTimelineStore.getState();

  if (frame.ownerClipId) {
    timeline.setCompositeContent(frame.ownerClipId, content);
    const updatedClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === frame.ownerClipId);
    return updatedClip?.type === "composite" ? updatedClip : null;
  }

  const trackId = pickCompositeTrackId(timeline.tracks);
  const compositeClip = createCompositeTimelineClip({
    content,
    trackId,
    start: frame.insertStartTick,
    name: frame.name,
  });
  timeline.addClip(compositeClip);
  timeline.selectClip(compositeClip.id);
  return compositeClip;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Composite timeline update failed.";
}

export const useCompositeTimelineStore = create<CompositeTimelineState>((set, get) => ({
  stack: [],
  isBusy: false,
  lastError: null,

  startBlankSubtimeline: () => {
    const state = get();
    if (state.isBusy) return false;

    const previousSnapshot = getCurrentTimelineSnapshot();
    const insertStartTick = playbackClock.time;
    useTimelineStore.getState().setTimelinePersistenceSuspended(true);
    useTimelineStore
      .getState()
      .replaceTimelineSnapshot(createDefaultTimelineSnapshot());
    playbackClock.setTime(0);

    set({
      stack: [
        ...state.stack,
        {
          previousSnapshot,
          ownerClipId: null,
          insertStartTick,
          name: "Scene",
        },
      ],
      lastError: null,
    });
    return true;
  },

  openCompositeClip: (clipId) => {
    const state = get();
    if (state.isBusy) return false;

    const timelineSnapshot = getCurrentTimelineSnapshot();
    const clip = timelineSnapshot.clips.find(
      (candidate): candidate is CompositeTimelineClip =>
        candidate.id === clipId && candidate.type === "composite",
    );
    if (!clip) return false;

    useTimelineStore.getState().setTimelinePersistenceSuspended(true);
    useTimelineStore.getState().replaceTimelineSnapshot(getSnapshotForCompositeClip(clip));
    playbackClock.setTime(0);

    set({
      stack: [
        ...state.stack,
        {
          previousSnapshot: timelineSnapshot,
          ownerClipId: clip.id,
          insertStartTick: clip.start,
          name: clip.name,
        },
      ],
      lastError: null,
    });
    return true;
  },

  exitToMainTimeline: async () => {
    const state = get();
    if (state.isBusy || state.stack.length === 0) return false;

    set({ isBusy: true, lastError: null });

    try {
      let stack = [...get().stack];
      let contentToSave = getCurrentCompositeContent();
      const renderJobs: CompositeRenderJob[] = [];

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        stack = stack.slice(0, -1);

        useTimelineStore
          .getState()
          .replaceTimelineSnapshot(cloneTimelineSnapshot(frame.previousSnapshot));

        const returningToMainTimeline = stack.length === 0;
        if (returningToMainTimeline) {
          useTimelineStore.getState().setTimelinePersistenceSuspended(false);
        }

        const shouldCommitFrame =
          frame.ownerClipId !== null || !isEmptyNewSceneContent(contentToSave);
        const savedClip = shouldCommitFrame
          ? saveContentToRestoredTimeline(frame, contentToSave)
          : null;

        if (savedClip && returningToMainTimeline) {
          renderJobs.push({
            clipId: savedClip.id,
            content: structuredClone(savedClip.content),
          });
        }

        set({ stack });

        if (stack.length > 0) {
          contentToSave = getCurrentCompositeContent();
        }
      }

      set({ isBusy: false, lastError: null });
      renderJobs.forEach((job) => {
        scheduleCompositeProxyRender(job.clipId, job.content);
      });
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      useTimelineStore.getState().setTimelinePersistenceSuspended(false);
      set({ isBusy: false, lastError: message });
      console.error("Failed to save composite subtimeline", error);
      return false;
    }
  },

  clearLastError: () => set({ lastError: null }),
}));
