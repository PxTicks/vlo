import { getTimelineTime, type TimelineTimeSnapshot } from "./timelineTime";

let readSnapshot: (() => TimelineTimeSnapshot) | undefined;

/** The store supplies its reader so the timing model never imports mutable UI state. */
export function setLiveTimelineTimeSource(read: () => TimelineTimeSnapshot): void {
  readSnapshot = read;
}

export function getLiveTimelineTime() {
  if (!readSnapshot) throw new Error("The timeline store has not initialized its clock");
  return getTimelineTime(readSnapshot());
}
