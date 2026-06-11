import { create } from "zustand";
import type { CompositeContent } from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import { useProjectStore } from "../project/useProjectStore";
import { playbackClock } from "../../core/playback/PlaybackClock";
import { TICKS_PER_SECOND } from "../../core/time/constants";
import { createDefaultTimelineSnapshot } from "../timeline/model/timelineTrackModel";
import { computeFurthestPresentationEnd } from "../timeline/utils/clipPresentation";
import { useTimelineStore } from "../timeline/useTimelineStore";
import { useCompositeLibraryStore } from "./useCompositeLibraryStore";

interface CompositeTimelineFrame {
  previousSnapshot: TimelineSnapshot;
  ownerCompositeAssetId?: string | null;
  name: string;
  ownerClipId?: string | null;
  insertStartTick?: number;
}

interface CompositeTimelineState {
  stack: CompositeTimelineFrame[];
  isBusy: boolean;
  lastError: string | null;
  startBlankCompositeAsset: () => boolean;
  startBlankSubtimeline: () => boolean;
  openCompositeAsset: (compositeAssetId: string) => boolean;
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

function getSnapshotForCompositeContent(content: CompositeContent): TimelineSnapshot {
  return {
    tracks:
      content.tracks && content.tracks.length > 0
        ? structuredClone(content.tracks)
        : createDefaultTimelineSnapshot().tracks,
    clips: structuredClone(content.clips),
  };
}

function getCurrentCompositeContent(): CompositeContent {
  const { clips, tracks } = useTimelineStore.getState();
  // Presentation-aware so an adjustment-speed clip inside the subtimeline bakes
  // to its true rendered length; clamped to a 1s minimum like an empty scene.
  const durationTicks = Math.max(
    TICKS_PER_SECOND,
    computeFurthestPresentationEnd(
      tracks,
      clips,
      useProjectStore.getState().config.fps,
    ),
  );

  return {
    clips: structuredClone(clips),
    tracks: structuredClone(tracks),
    durationTicks,
    fps: useProjectStore.getState().config.fps,
    frameStep: 1,
  };
}

function isEmptyNewSceneContent(content: CompositeContent): boolean {
  return content.clips.length === 0;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Composite timeline update failed.";
}

export const useCompositeTimelineStore = create<CompositeTimelineState>(
  (set, get) => ({
    stack: [],
    isBusy: false,
    lastError: null,

    startBlankCompositeAsset: () => {
      const state = get();
      if (state.isBusy) return false;

      // Blank composites are browser-only: they create a top-level asset and
      // never place a clip. Starting one while already inside a subtimeline
      // edit would push a frame whose content `exitToMainTimeline` saves as a
      // fresh asset the parent composite never references — orphaning it. The
      // UI hides this entry point during subtimeline editing
      // (CompositePanel gates on stack depth), but guard here too so the store
      // stays self-consistent regardless of caller.
      if (state.stack.length > 0) return false;

      const previousSnapshot = getCurrentTimelineSnapshot();
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
            ownerCompositeAssetId: null,
            name: "Scene",
          },
        ],
        lastError: null,
      });
      return true;
    },

    startBlankSubtimeline: () => get().startBlankCompositeAsset(),

    openCompositeAsset: (compositeAssetId) => {
      const state = get();
      if (state.isBusy) return false;

      const timelineSnapshot = getCurrentTimelineSnapshot();
      const compositeAsset = useCompositeLibraryStore
        .getState()
        .composites.find(
          (candidate) => candidate.id === compositeAssetId,
        );
      if (!compositeAsset) {
        return false;
      }

      useTimelineStore.getState().setTimelinePersistenceSuspended(true);
      useTimelineStore
        .getState()
        .replaceTimelineSnapshot(
          getSnapshotForCompositeContent(compositeAsset.content),
        );
      playbackClock.setTime(0);

      set({
        stack: [
          ...state.stack,
          {
            previousSnapshot: timelineSnapshot,
            ownerCompositeAssetId: compositeAsset.id,
            name: compositeAsset.name,
          },
        ],
        lastError: null,
      });
      return true;
    },

    openCompositeClip: (clipId) => {
      const clip = useTimelineStore
        .getState()
        .clips.find((candidate) => candidate.id === clipId);
      if (!isCompositeClip(clip)) {
        return false;
      }
      return get().openCompositeAsset(clip.compositeId);
    },

    exitToMainTimeline: async () => {
      const state = get();
      if (state.isBusy || state.stack.length === 0) return false;

      set({ isBusy: true, lastError: null });

      try {
        let stack = [...get().stack];
        let contentToSave = getCurrentCompositeContent();

        while (stack.length > 0) {
          const frame = stack[stack.length - 1];
          stack = stack.slice(0, -1);

          const shouldCommitFrame =
            typeof frame.ownerCompositeAssetId === "string" ||
            !isEmptyNewSceneContent(contentToSave);

          // Restore the parent timeline BEFORE committing. Committing an edit
          // re-bakes and relinks every placement of this composite to the fresh
          // asset; that relink must run against the parent timeline's
          // placements, not the subtimeline content we just captured. Restoring
          // first (and dropping persistence suspension when we're back on the
          // main timeline) keeps the placement's `assetId` consistent with the
          // bake we keep, so it never points at the deleted old bake.
          useTimelineStore
            .getState()
            .replaceTimelineSnapshot(
              cloneTimelineSnapshot(frame.previousSnapshot),
            );

          const returningToMainTimeline = stack.length === 0;
          if (returningToMainTimeline) {
            useTimelineStore.getState().setTimelinePersistenceSuspended(false);
          }

          if (shouldCommitFrame) {
            if (typeof frame.ownerCompositeAssetId === "string") {
              await useCompositeLibraryStore
                .getState()
                .updateCompositeAssetContent(frame.ownerCompositeAssetId, {
                  content: contentToSave,
                });
            } else {
              await useCompositeLibraryStore.getState().createCompositeAsset({
                name: frame.name,
                content: contentToSave,
              });
            }
          }

          set({ stack });

          if (stack.length > 0) {
            contentToSave = getCurrentCompositeContent();
          }
        }

        set({ isBusy: false, lastError: null });
        return true;
      } catch (error) {
        const message = getErrorMessage(error);
        useTimelineStore
          .getState()
          .setTimelinePersistenceSuspended(get().stack.length > 0);
        set({ isBusy: false, lastError: message });
        console.error("Failed to save composite subtimeline", error);
        return false;
      }
    },

    clearLastError: () => set({ lastError: null }),
  }),
);
