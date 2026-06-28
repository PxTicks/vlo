import { useShallow } from "zustand/react/shallow";
import type {
  ExtensionTimelineClip,
  ClipTransform,
  MaskTimelineClip,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../types/TimelineTypes";
import { isExtensionTimelineClip } from "../../types/TimelineTypes";
import type {
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineTransactionResult,
} from "@vlo/extension-sdk";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import {
  selectMaskClipsForParent,
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
} from "./selectors/timelineSelectors";
import { useTimelineStore } from "./useTimelineStore";
import { useProjectStore } from "../project/useProjectStore";
import type { ExtensionTimelineCommand } from "./model/extensionTimelineCommands";

type TimelineStoreState = ReturnType<typeof useTimelineStore.getState>;

export {
  selectMaskClipsForParent,
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

export function useTimelineTransitions(): Transition[] {
  return useTimelineStore(useShallow((state) => state.transitions));
}

export function useSelectedTimelineTransitionId(): string | null {
  return useTimelineStore((state) => state.selectedTransitionId);
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

export function useMaskClipsForParent(
  parentClipId: string | null | undefined,
): MaskTimelineClip[] {
  return useTimelineStore(
    useShallow((state) =>
      parentClipId ? selectMaskClipsForParent(state, parentClipId) : [],
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

export function getTimelineTransitions(): Transition[] {
  return useTimelineStore.getState().transitions;
}

export function getTimelineModelState(): Pick<
  TimelineStoreState,
  "clips" | "tracks" | "transitions"
> {
  const { clips, tracks, transitions } = useTimelineStore.getState();
  return { clips, tracks, transitions };
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

export function getExtensionTimelineEntities(
  ownerId: string,
): readonly ExtensionTimelineEntitySnapshot[] {
  return Object.freeze(
    useTimelineStore
      .getState()
      .clips.filter(
        (clip): clip is ExtensionTimelineClip =>
          isExtensionTimelineClip(clip) &&
          clip.extensionPayload.extensionId === ownerId,
      )
      .map((clip) =>
        Object.freeze({
          id: clip.id,
          trackId: clip.trackId,
          startTicks: clip.start,
          durationTicks: clip.timelineDuration,
          payload: structuredClone(clip.extensionPayload),
        }),
      ),
  );
}

export function commitExtensionTimelineTransaction(
  label: string,
  ownerId: string,
  commands: readonly ExtensionTimelineCommand[],
): ExtensionTimelineTransactionResult {
  return useTimelineStore
    .getState()
    .commitExtensionTransaction(label, ownerId, commands);
}

export function replaceTimelineSnapshot(
  snapshot: TimelineSnapshot | null,
): void {
  useTimelineStore.getState().replaceTimelineSnapshot(snapshot);
}

export function addTimelineClipTransform(
  clipId: string,
  transform: ClipTransform,
): void {
  useTimelineStore.getState().addClipTransform(clipId, transform);
}

export function addTimelineAdjustmentClip(
  input: Parameters<TimelineStoreState["addAdjustmentClip"]>[0],
): string | null {
  return useTimelineStore.getState().addAdjustmentClip(input);
}

export function selectTimelineClip(
  clipId: string | null,
  isMulti?: boolean,
): void {
  useTimelineStore.getState().selectClip(clipId, isMulti);
}

export function selectTimelineTransition(transitionId: string | null): void {
  useTimelineStore.getState().selectTransition(transitionId);
}

export function addTimelineTransition(
  transition: Transition,
  options?: { incomingStart?: number },
): boolean {
  return useTimelineStore.getState().addTransition(transition, options);
}

export function updateTimelineTransitionParameters(
  transitionId: string,
  updates: Record<string, unknown>,
): boolean {
  return useTimelineStore
    .getState()
    .updateTransitionParameters(transitionId, updates);
}

export async function flushPendingTimelinePersistence(): Promise<void> {
  await useTimelineStore.getState().flushPendingPersistence();
}

export type { ExtensionTimelineCommand, TimelineStoreState };
