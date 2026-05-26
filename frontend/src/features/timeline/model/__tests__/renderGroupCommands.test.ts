import { describe, expect, it, vi } from "vitest";
import type {
  TimelineGroup,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  createGroupInDraft,
  deleteGroupFromDraft,
  isGroupOverlapValid,
  isGroupTrackRangeContiguous,
  pruneOrphanedGroupTrackIds,
  setGroupTimeRangeInDraft,
  setGroupTrackIdsInDraft,
  setGroupTransformationsInDraft,
  setGroupVisibilityInDraft,
} from "../renderGroupCommands";
import type { TimelineModelState } from "../timelineTrackModel";

function track(id: string, type: TimelineTrack["type"] = "visual"): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function makeGroup(overrides: Partial<TimelineGroup> & Pick<TimelineGroup, "id">): TimelineGroup {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    trackIds: overrides.trackIds ?? [],
    start: overrides.start ?? 0,
    timelineDuration: overrides.timelineDuration ?? 100,
    transformations: overrides.transformations ?? [],
    isVisible: overrides.isVisible ?? true,
    isCollapsed: overrides.isCollapsed,
  };
}

function makeDraft(
  tracks: TimelineTrack[],
  groups: TimelineGroup[] = [],
): TimelineModelState {
  return { tracks, clips: [], groups };
}

describe("renderGroupCommands — validators", () => {
  describe("isGroupTrackRangeContiguous", () => {
    it("accepts a single track", () => {
      const state = { tracks: [track("a"), track("b"), track("c")] };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["b"] })).toBe(true);
    });

    it("accepts adjacent visual tracks regardless of input order", () => {
      const state = { tracks: [track("a"), track("b"), track("c")] };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["c", "a", "b"] })).toBe(true);
    });

    it("rejects a non-contiguous run (skip in the middle)", () => {
      const state = { tracks: [track("a"), track("b"), track("c"), track("d")] };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["a", "c"] })).toBe(false);
    });

    it("treats undefined-type tracks as visual", () => {
      const state = {
        tracks: [track("a", undefined), track("b", undefined), track("c", undefined)],
      };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["a", "b"] })).toBe(true);
    });

    it("ignores non-visual tracks when computing contiguity", () => {
      const state = {
        tracks: [
          track("v1", "visual"),
          track("a1", "audio"),
          track("v2", "visual"),
        ],
      };
      // v1 and v2 are visual indices 0 and 1 → contiguous.
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["v1", "v2"] })).toBe(true);
    });

    it("rejects empty trackIds", () => {
      const state = { tracks: [track("a")] };
      expect(isGroupTrackRangeContiguous(state, { trackIds: [] })).toBe(false);
    });

    it("rejects unknown trackIds", () => {
      const state = { tracks: [track("a")] };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["nope"] })).toBe(false);
    });

    it("rejects audio tracks (not visual)", () => {
      const state = {
        tracks: [track("v1", "visual"), track("a1", "audio")],
      };
      expect(isGroupTrackRangeContiguous(state, { trackIds: ["a1"] })).toBe(false);
    });
  });

  describe("isGroupOverlapValid", () => {
    it("permits two groups over the same track when windows are disjoint", () => {
      const state = {
        groups: [
          makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        ],
      };
      expect(
        isGroupOverlapValid(state, {
          trackIds: ["a"],
          start: 100,
          timelineDuration: 50,
        }),
      ).toBe(true);
    });

    it("uses half-open semantics at the boundary", () => {
      const state = {
        groups: [
          makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        ],
      };
      // Touching at end-of-A = start-of-B is allowed.
      expect(
        isGroupOverlapValid(state, {
          trackIds: ["a"],
          start: 100,
          timelineDuration: 50,
        }),
      ).toBe(true);
      // 1 tick of overlap is rejected.
      expect(
        isGroupOverlapValid(state, {
          trackIds: ["a"],
          start: 99,
          timelineDuration: 50,
        }),
      ).toBe(false);
    });

    it("rejects time-overlapping groups that share at least one track", () => {
      const state = {
        groups: [
          makeGroup({
            id: "g1",
            trackIds: ["a", "b"],
            start: 0,
            timelineDuration: 100,
          }),
        ],
      };
      expect(
        isGroupOverlapValid(state, {
          trackIds: ["b", "c"],
          start: 50,
          timelineDuration: 100,
        }),
      ).toBe(false);
    });

    it("permits time-overlapping groups that share no tracks", () => {
      const state = {
        groups: [
          makeGroup({
            id: "g1",
            trackIds: ["a", "b"],
            start: 0,
            timelineDuration: 100,
          }),
        ],
      };
      expect(
        isGroupOverlapValid(state, {
          trackIds: ["c"],
          start: 0,
          timelineDuration: 100,
        }),
      ).toBe(true);
    });

    it("excludes the candidate's own id from the overlap check", () => {
      const state = {
        groups: [
          makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        ],
      };
      expect(
        isGroupOverlapValid(state, {
          id: "g1",
          trackIds: ["a"],
          start: 0,
          timelineDuration: 100,
        }),
      ).toBe(true);
    });
  });
});

describe("renderGroupCommands — draft helpers", () => {
  it("createGroupInDraft pushes a group when invariants hold", () => {
    const draft = makeDraft([track("a"), track("b")]);
    const group = createGroupInDraft(draft, {
      trackIds: ["a", "b"],
      start: 0,
      timelineDuration: 100,
    });
    expect(group).not.toBeNull();
    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0].trackIds).toEqual(["a", "b"]);
    expect(draft.groups[0].transformations).toEqual([]);
    expect(draft.groups[0].isVisible).toBe(true);
  });

  it("createGroupInDraft normalizes trackIds to top-to-bottom visual order on write", () => {
    const draft = makeDraft([track("a"), track("b"), track("c")]);
    const group = createGroupInDraft(draft, {
      trackIds: ["c", "a", "b"],
      start: 0,
      timelineDuration: 100,
    });
    expect(group).not.toBeNull();
    expect(draft.groups[0].trackIds).toEqual(["a", "b", "c"]);
  });

  it("createGroupInDraft rejects an explicit id that collides with an existing group", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft(
      [track("a"), track("b")],
      [makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 })],
    );
    // Disjoint window (so the overlap check alone would *pass* for a fresh id);
    // the duplicate-id check must reject independently.
    const result = createGroupInDraft(draft, {
      id: "g1",
      trackIds: ["b"],
      start: 500,
      timelineDuration: 100,
    });
    expect(result).toBeNull();
    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0].trackIds).toEqual(["a"]);
    vi.restoreAllMocks();
  });

  it("createGroupInDraft applies overlap check even when a colliding id is passed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft(
      [track("a")],
      [makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 })],
    );
    // Caller smuggles in the existing id alongside an overlapping window.
    // The duplicate-id check would catch this, but even if it didn't the
    // overlap check must still apply against the existing group.
    const result = createGroupInDraft(draft, {
      id: "g1",
      trackIds: ["a"],
      start: 50,
      timelineDuration: 100,
    });
    expect(result).toBeNull();
    expect(draft.groups).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("createGroupInDraft rejects non-contiguous tracks", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft([track("a"), track("b"), track("c")]);
    const result = createGroupInDraft(draft, {
      trackIds: ["a", "c"],
      start: 0,
      timelineDuration: 100,
    });
    expect(result).toBeNull();
    expect(draft.groups).toEqual([]);
    vi.restoreAllMocks();
  });

  it("createGroupInDraft rejects overlap over a shared track", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft(
      [track("a"), track("b")],
      [makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 })],
    );
    const result = createGroupInDraft(draft, {
      trackIds: ["a"],
      start: 50,
      timelineDuration: 100,
    });
    expect(result).toBeNull();
    expect(draft.groups).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("createGroupInDraft rejects empty / non-positive inputs", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft([track("a")]);
    expect(
      createGroupInDraft(draft, { trackIds: [], start: 0, timelineDuration: 100 }),
    ).toBeNull();
    expect(
      createGroupInDraft(draft, {
        trackIds: ["a"],
        start: -1,
        timelineDuration: 100,
      }),
    ).toBeNull();
    expect(
      createGroupInDraft(draft, {
        trackIds: ["a"],
        start: 0,
        timelineDuration: 0,
      }),
    ).toBeNull();
    expect(draft.groups).toEqual([]);
    vi.restoreAllMocks();
  });

  it("deleteGroupFromDraft removes only the group metadata", () => {
    const draft = makeDraft(
      [track("a")],
      [
        makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        makeGroup({ id: "g2", trackIds: ["a"], start: 200, timelineDuration: 50 }),
      ],
    );
    expect(deleteGroupFromDraft(draft, "g1")).toBe(true);
    expect(draft.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(draft.tracks).toHaveLength(1);
  });

  it("deleteGroupFromDraft returns false for unknown ids", () => {
    const draft = makeDraft([track("a")]);
    expect(deleteGroupFromDraft(draft, "nope")).toBe(false);
  });

  it("setGroupTrackIdsInDraft applies both invariants", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft(
      [track("a"), track("b"), track("c")],
      [
        makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        makeGroup({ id: "g2", trackIds: ["c"], start: 0, timelineDuration: 100 }),
      ],
    );
    // Non-contiguous expansion: a + c (b skipped)
    expect(setGroupTrackIdsInDraft(draft, "g1", ["a", "c"])).toBe(false);
    // Overlap-onto-g2 over track c
    expect(setGroupTrackIdsInDraft(draft, "g1", ["a", "b", "c"])).toBe(false);
    // Valid expansion to a contiguous range that doesn't collide
    expect(setGroupTrackIdsInDraft(draft, "g1", ["a", "b"])).toBe(true);
    expect(draft.groups[0].trackIds).toEqual(["a", "b"]);
    vi.restoreAllMocks();
  });

  it("setGroupTrackIdsInDraft normalizes to top-to-bottom order on write", () => {
    const draft = makeDraft(
      [track("a"), track("b"), track("c")],
      [makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 })],
    );
    expect(setGroupTrackIdsInDraft(draft, "g1", ["c", "a", "b"])).toBe(true);
    expect(draft.groups[0].trackIds).toEqual(["a", "b", "c"]);
  });

  it("setGroupTimeRangeInDraft respects overlap invariant", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const draft = makeDraft(
      [track("a")],
      [
        makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 }),
        makeGroup({ id: "g2", trackIds: ["a"], start: 200, timelineDuration: 100 }),
      ],
    );
    expect(setGroupTimeRangeInDraft(draft, "g1", 150, 100)).toBe(false);
    expect(setGroupTimeRangeInDraft(draft, "g1", 100, 50)).toBe(true);
    expect(draft.groups[0].start).toBe(100);
    expect(draft.groups[0].timelineDuration).toBe(50);
    vi.restoreAllMocks();
  });

  it("setGroupVisibility / setGroupTransformations mutate without invariants", () => {
    const draft = makeDraft(
      [track("a")],
      [makeGroup({ id: "g1", trackIds: ["a"], start: 0, timelineDuration: 100 })],
    );
    expect(setGroupVisibilityInDraft(draft, "g1", false)).toBe(true);
    expect(draft.groups[0].isVisible).toBe(false);

    const transform = {
      id: "t1",
      type: "position",
      isEnabled: true,
      parameters: { x: 1, y: 2 },
    };
    expect(setGroupTransformationsInDraft(draft, "g1", [transform])).toBe(true);
    expect(draft.groups[0].transformations).toEqual([transform]);
  });
});

describe("renderGroupCommands — pruneOrphanedGroupTrackIds", () => {
  it("drops trackIds that no longer reference live tracks", () => {
    const draft = makeDraft(
      [track("a")],
      [
        makeGroup({
          id: "g1",
          trackIds: ["a", "ghost"],
          start: 0,
          timelineDuration: 100,
        }),
      ],
    );
    pruneOrphanedGroupTrackIds(draft);
    expect(draft.groups[0].trackIds).toEqual(["a"]);
  });

  it("keeps groups even when all their tracks are removed", () => {
    const draft = makeDraft(
      [track("a")],
      [
        makeGroup({
          id: "g1",
          trackIds: ["ghost1", "ghost2"],
          start: 0,
          timelineDuration: 100,
        }),
      ],
    );
    pruneOrphanedGroupTrackIds(draft);
    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0].trackIds).toEqual([]);
  });
});
