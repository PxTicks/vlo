import { getTimelineTime, type TimelineTime, type TimelineTimeSnapshot } from "./timelineTime";

let readSnapshot: (() => TimelineTimeSnapshot) | undefined;

/** The store supplies its reader so the timing model never imports mutable UI state. */
export function setLiveTimelineTimeSource(read: () => TimelineTimeSnapshot): void {
  readSnapshot = read;
}

export function getLiveTimelineTime() {
  if (!readSnapshot) throw new Error("The timeline store has not initialized its clock");
  return getTimelineTime(readSnapshot());
}

export type ClipOffsetMapping = Pick<TimelineTime, "toClipOffset" | "toPresentationOffset">;

/**
 * Clip-local offset mapping against the live timeline. Its identity never
 * changes, so it can be handed to memoized clip components without
 * re-rendering them on every commit. A clip whose mapping changes also gets
 * a new presentation entry, which is what re-renders it.
 */
export const liveClipOffsetMapping: ClipOffsetMapping = Object.freeze({
  toClipOffset: (clipId, presentationOffset) =>
    getLiveTimelineTime().toClipOffset(clipId, presentationOffset),
  toPresentationOffset: (clipId, clipOffset) =>
    getLiveTimelineTime().toPresentationOffset(clipId, clipOffset),
});
