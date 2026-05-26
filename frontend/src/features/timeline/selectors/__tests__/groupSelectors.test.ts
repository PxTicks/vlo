import { describe, expect, it } from "vitest";
import type { TimelineGroup } from "../../../../types/TimelineTypes";
import {
  selectActiveGroupsAtTick,
  selectGroupForTrackAtTick,
} from "../groupSelectors";

function group(overrides: Partial<TimelineGroup> & Pick<TimelineGroup, "id">): TimelineGroup {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    trackIds: overrides.trackIds ?? [],
    start: overrides.start ?? 0,
    timelineDuration: overrides.timelineDuration ?? 100,
    transformations: overrides.transformations ?? [],
    isVisible: overrides.isVisible ?? true,
  };
}

describe("groupSelectors", () => {
  describe("selectActiveGroupsAtTick", () => {
    it("honours half-open [start, start + duration) semantics", () => {
      const state = {
        groups: [group({ id: "g1", start: 100, timelineDuration: 50 })],
      };
      // Just before start
      expect(selectActiveGroupsAtTick(state, 99)).toEqual([]);
      // At start (inclusive)
      expect(selectActiveGroupsAtTick(state, 100)).toEqual(state.groups);
      // One tick before the end (inclusive)
      expect(selectActiveGroupsAtTick(state, 149)).toEqual(state.groups);
      // At the end (exclusive)
      expect(selectActiveGroupsAtTick(state, 150)).toEqual([]);
    });

    it("returns multiple groups when they're concurrently active over disjoint tracks", () => {
      const state = {
        groups: [
          group({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
          group({ id: "g2", trackIds: ["b"], start: 0, timelineDuration: 100 }),
        ],
      };
      const active = selectActiveGroupsAtTick(state, 50);
      expect(active.map((g) => g.id)).toEqual(["g1", "g2"]);
    });
  });

  describe("selectGroupForTrackAtTick", () => {
    it("returns the active group containing the track", () => {
      const state = {
        groups: [
          group({ id: "g1", trackIds: ["a", "b"], start: 0, timelineDuration: 100 }),
        ],
      };
      expect(selectGroupForTrackAtTick(state, "a", 50)?.id).toBe("g1");
      expect(selectGroupForTrackAtTick(state, "b", 50)?.id).toBe("g1");
    });

    it("returns null when no group covers the track at the tick", () => {
      const state = {
        groups: [
          group({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        ],
      };
      // Wrong track
      expect(selectGroupForTrackAtTick(state, "z", 50)).toBeNull();
      // Right track, outside window
      expect(selectGroupForTrackAtTick(state, "a", 200)).toBeNull();
    });

    it("disambiguates time-disjoint groups over the same track", () => {
      const state = {
        groups: [
          group({ id: "early", trackIds: ["a"], start: 0, timelineDuration: 100 }),
          group({ id: "late", trackIds: ["a"], start: 200, timelineDuration: 100 }),
        ],
      };
      expect(selectGroupForTrackAtTick(state, "a", 50)?.id).toBe("early");
      expect(selectGroupForTrackAtTick(state, "a", 250)?.id).toBe("late");
      expect(selectGroupForTrackAtTick(state, "a", 150)).toBeNull();
    });
  });
});
