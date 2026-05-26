import type { TimelineGroup } from "../../../types/TimelineTypes";
import { isGroupActiveAtTick } from "../../../types/TimelineTypes";

export interface RenderGroupCollectionState {
  groups: TimelineGroup[];
}

export function selectActiveGroupsAtTick(
  state: RenderGroupCollectionState,
  tick: number,
): TimelineGroup[] {
  return state.groups.filter((group) => isGroupActiveAtTick(group, tick));
}

/**
 * Returns the single render group that's active over `trackId` at `tick`, or
 * `null` if none. Per command-layer invariants there is at most one such
 * group; if more than one is found (an invariant violation), the first match
 * wins so the renderer stays deterministic.
 */
export function selectGroupForTrackAtTick(
  state: RenderGroupCollectionState,
  trackId: string,
  tick: number,
): TimelineGroup | null {
  for (const group of state.groups) {
    if (!group.trackIds.includes(trackId)) continue;
    if (isGroupActiveAtTick(group, tick)) return group;
  }
  return null;
}
