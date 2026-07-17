import { create } from "zustand";
import type { CompositeContent } from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import { playbackClock } from "../../core/playback/PlaybackClock";
import {
  createEmptyTimelineSnapshot,
  getTimelineClipById,
  getTimelineCompositeContent,
  getTimelineCompositePlacementIds,
  getTimelineSnapshot,
  remapTimelineCompositePlacement,
  replaceTimelineSnapshot,
  setTimelinePersistenceSuspended,
} from "../timeline/api";
import { useCompositeLibraryStore } from "./useCompositeLibraryStore";
import { resolveCompositeRevision } from "./utils/compositeBakeValidity";

interface CompositeTimelineFrame {
  previousSnapshot: TimelineSnapshot;
  ownerCompositeAssetId?: string | null;
  name: string;
  ownerClipId?: string | null;
  insertStartTick?: number;
  initialContentSnapshot?: string;
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
    transitions: structuredClone(snapshot.transitions ?? []),
  };
}

function getCurrentTimelineSnapshot(): TimelineSnapshot {
  return getTimelineSnapshot();
}

function getSnapshotForCompositeContent(content: CompositeContent): TimelineSnapshot {
  return {
    tracks:
      content.tracks && content.tracks.length > 0
        ? structuredClone(content.tracks)
        : createEmptyTimelineSnapshot().tracks,
    clips: structuredClone(content.clips),
    transitions: structuredClone(content.transitions ?? []),
  };
}

function getCurrentCompositeContent(): CompositeContent {
  return getTimelineCompositeContent();
}

function isEmptyNewSceneContent(content: CompositeContent): boolean {
  return content.clips.length === 0;
}

function serializeCompositeContent(content: CompositeContent): string {
  return JSON.stringify(content);
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
      setTimelinePersistenceSuspended(true);
      replaceTimelineSnapshot(createEmptyTimelineSnapshot());
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

      setTimelinePersistenceSuspended(true);
      replaceTimelineSnapshot(getSnapshotForCompositeContent(compositeAsset.content));
      playbackClock.setTime(0);
      const initialContentSnapshot = serializeCompositeContent(
        getCurrentCompositeContent(),
      );

      set({
        stack: [
          ...state.stack,
          {
            previousSnapshot: timelineSnapshot,
            ownerCompositeAssetId: compositeAsset.id,
            name: compositeAsset.name,
            initialContentSnapshot,
          },
        ],
        lastError: null,
      });
      return true;
    },

    openCompositeClip: (clipId) => {
      const clip = getTimelineClipById(clipId);
      if (!isCompositeClip(clip)) {
        return false;
      }
      if (!get().openCompositeAsset(clip.compositeId)) return false;
      const stack = [...get().stack];
      const frame = stack[stack.length - 1];
      stack[stack.length - 1] = { ...frame, ownerClipId: clip.id };
      set({ stack });
      return true;
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
            (typeof frame.ownerCompositeAssetId === "string" &&
              serializeCompositeContent(contentToSave) !==
                frame.initialContentSnapshot) ||
            (typeof frame.ownerCompositeAssetId !== "string" &&
              !isEmptyNewSceneContent(contentToSave));

          // Restore the parent timeline BEFORE committing. The canonical edit
          // immediately advances every parent placement's revision, while the
          // background bake may relink its cache later. Both mutations must run
          // against the parent timeline, not the subtimeline just captured.
          replaceTimelineSnapshot(cloneTimelineSnapshot(frame.previousSnapshot));

          const returningToMainTimeline = stack.length === 0;
          if (returningToMainTimeline) {
            setTimelinePersistenceSuspended(false);
          }

          if (shouldCommitFrame) {
            if (typeof frame.ownerCompositeAssetId === "string") {
              const placementIds = getTimelineCompositePlacementIds([
                frame.ownerCompositeAssetId,
              ]);
              const shouldForkPlacement =
                typeof frame.ownerClipId === "string" &&
                placementIds.length > 1;

              if (shouldForkPlacement) {
                const fork = await useCompositeLibraryStore
                  .getState()
                  .createCompositeAsset({
                    name: frame.name,
                    content: contentToSave,
                  });
                const didRemap = remapTimelineCompositePlacement(
                  frame.ownerClipId!,
                  frame.ownerCompositeAssetId,
                  fork.id,
                  resolveCompositeRevision(fork),
                );
                if (!didRemap) {
                  await useCompositeLibraryStore
                    .getState()
                    .deleteCompositeAsset(fork.id);
                  throw new Error(
                    "The edited composite placement no longer exists.",
                  );
                }
              } else {
                await useCompositeLibraryStore
                  .getState()
                  .updateCompositeAssetContent(frame.ownerCompositeAssetId, {
                    content: contentToSave,
                  });
              }
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
        setTimelinePersistenceSuspended(get().stack.length > 0);
        set({ isBusy: false, lastError: message });
        console.error("Failed to save composite subtimeline", error);
        return false;
      }
    },

    clearLastError: () => set({ lastError: null }),
  }),
);
