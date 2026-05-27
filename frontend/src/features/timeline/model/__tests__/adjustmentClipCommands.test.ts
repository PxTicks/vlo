import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdjustmentTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  createAdjustmentClipInDraft,
  insertAdjustmentTrackInDraft,
  setAdjustmentDepthInDraft,
} from "../adjustmentClipCommands";
import {
  addClipToDraft,
  moveClipsInDraft,
  addClipTransformToDraft,
  setClipTransformsAndShapeInDraft,
} from "../timelineCommands";
import type { TimelineModelState } from "../timelineTrackModel";

function visualTrack(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function adjustmentTrack(id: string): TimelineTrack {
  return {
    id,
    type: "adjustment",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function makeDraft(tracks: TimelineTrack[]): TimelineModelState {
  return { tracks, clips: [] };
}

function videoClip(id: string, trackId: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `asset-${id}`,
    start: 0,
    timelineDuration: 1000,
    sourceDuration: 1000,
    transformedDuration: 1000,
    transformedOffset: 0,
    croppedSourceDuration: 1000,
    offset: 0,
    transformations: [],
  } as TimelineClip;
}

function adjustmentClip(overrides: {
  id: string;
  trackId: string;
  start?: number;
  timelineDuration?: number;
  depth?: number;
}): AdjustmentTimelineClip {
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start ?? 0,
    timelineDuration: overrides.timelineDuration ?? 100,
    sourceDuration: null,
    transformedDuration: overrides.timelineDuration ?? 100,
    transformedOffset: 0,
    croppedSourceDuration: overrides.timelineDuration ?? 100,
    offset: 0,
    transformations: [],
    depth: overrides.depth ?? 1,
  };
}

describe("track-type compatibility (general)", () => {
  // The store-layer enforcement is type-agnostic: a typed track only
  // accepts clips whose `getTrackTypeFromClipType` matches its `type`.
  // Adjustment clips fall through that same mechanism with no special
  // case — these tests cover the adjustment path alongside the existing
  // visual / audio exclusions to document the unified contract.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("addClipToDraft", () => {
    it("rejects a video clip on an adjustment track", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, videoClip("v1", "adj"));
      expect(draft.clips).toEqual([]);
    });

    it("rejects an adjustment clip on a visual track", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, adjustmentClip({ id: "adj1", trackId: "v" }));
      expect(draft.clips).toEqual([]);
    });

    it("accepts an adjustment clip on an adjustment track", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "adj1", trackId: "adj" }));
      expect(draft.clips).toHaveLength(1);
      expect(draft.clips[0].id).toBe("adj1");
    });

    it("accepts a video clip on a visual track", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      expect(draft.clips).toHaveLength(1);
    });

    it("accepts any clip on an untyped track (which then acquires the type)", () => {
      const draft: TimelineModelState = {
        tracks: [{ ...visualTrack("untyped"), type: undefined }],
        clips: [],
      };
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "untyped" }));
      expect(draft.clips).toHaveLength(1);
      const track = draft.tracks.find((t) => t.id === "untyped")!;
      expect(track.type).toBe("adjustment");
    });
  });

  describe("moveClipsInDraft", () => {
    it("rejects the whole batch when any destination is incompatible", () => {
      const draft = makeDraft([adjustmentTrack("adj"), visualTrack("v")]);
      addClipToDraft(draft, adjustmentClip({ id: "adj1", trackId: "adj" }));
      addClipToDraft(
        draft,
        adjustmentClip({ id: "adj2", trackId: "adj", start: 200 }),
      );
      // One valid move (stays on adj), one invalid (moves to visual v).
      // Whole batch rejected.
      moveClipsInDraft(draft, [
        { clipId: "adj1", start: 50, trackId: "adj" },
        { clipId: "adj2", start: 250, trackId: "v" },
      ]);
      const a1 = draft.clips.find((c) => c.id === "adj1")!;
      const a2 = draft.clips.find((c) => c.id === "adj2")!;
      expect(a1.start).toBe(0);
      expect(a2.start).toBe(200);
      expect(a2.trackId).toBe("adj");
    });

    it("rejects moving a video clip onto an adjustment track", () => {
      const draft = makeDraft([visualTrack("v"), adjustmentTrack("adj")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      moveClipsInDraft(draft, [
        { clipId: "v1", start: 100, trackId: "adj" },
      ]);
      const v1 = draft.clips.find((c) => c.id === "v1")!;
      expect(v1.trackId).toBe("v");
      expect(v1.start).toBe(0);
    });

    it("permits compatible moves (same-type destination)", () => {
      const draft = makeDraft([
        adjustmentTrack("adj1"),
        adjustmentTrack("adj2"),
      ]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj1" }));
      moveClipsInDraft(draft, [
        { clipId: "a", start: 100, trackId: "adj2" },
      ]);
      const a = draft.clips.find((c) => c.id === "a")!;
      expect(a.trackId).toBe("adj2");
      expect(a.start).toBe(100);
    });

    it("permits moves onto untyped tracks; type is set by syncTrackTypesFromClips after the move", () => {
      const draft: TimelineModelState = {
        tracks: [
          adjustmentTrack("adj"),
          { ...visualTrack("untyped"), type: undefined },
        ],
        clips: [],
      };
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      moveClipsInDraft(draft, [
        { clipId: "a", start: 0, trackId: "untyped" },
      ]);
      const a = draft.clips.find((c) => c.id === "a")!;
      expect(a.trackId).toBe("untyped");
      const untyped = draft.tracks.find((t) => t.id === "untyped")!;
      expect(untyped.type).toBe("adjustment");
    });
  });

  describe("speed-transform rejection on adjustment clips", () => {
    it("addClipTransformToDraft rejects a speed transform on an adjustment clip", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      addClipTransformToDraft(draft, "a", {
        id: "speed-1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2 },
      });
      const a = draft.clips.find((c) => c.id === "a")!;
      expect(a.transformations).toEqual([]);
    });

    it("addClipTransformToDraft permits a non-speed transform on an adjustment clip", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      addClipTransformToDraft(draft, "a", {
        id: "pos-1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 20 },
      });
      const a = draft.clips.find((c) => c.id === "a")!;
      expect(a.transformations).toHaveLength(1);
      expect(a.transformations[0].type).toBe("position");
    });

    it("addClipTransformToDraft permits a speed transform on a non-adjustment clip", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      addClipTransformToDraft(draft, "v1", {
        id: "speed-1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2 },
      });
      const v1 = draft.clips.find((c) => c.id === "v1")!;
      // fitMode default + speed
      expect(v1.transformations.find((t) => t.type === "speed")).toBeTruthy();
    });

    it("setClipTransformsInDraft (bulk replace) rejects a batch containing speed on an adjustment", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      // First add a valid transform.
      addClipTransformToDraft(draft, "a", {
        id: "pos-1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 20 },
      });
      // Try to bulk-replace including a speed transform.
      setClipTransformsAndShapeInDraft(draft, "a", [
        {
          id: "pos-2",
          type: "position",
          isEnabled: true,
          parameters: { x: 5, y: 5 },
        },
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ]);
      const a = draft.clips.find((c) => c.id === "a")!;
      // Whole batch rejected — original single position transform preserved.
      expect(a.transformations).toHaveLength(1);
      expect(a.transformations[0].id).toBe("pos-1");
    });
  });
});

describe("adjustment-clip commands", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("insertAdjustmentTrackInDraft", () => {
    it("inserts an adjustment-type track at the requested index", () => {
      const draft = makeDraft([visualTrack("v1"), visualTrack("v2")]);
      const id = insertAdjustmentTrackInDraft(draft, 1);
      expect(draft.tracks).toHaveLength(3);
      expect(draft.tracks[1].id).toBe(id);
      expect(draft.tracks[1].type).toBe("adjustment");
    });

    it("defaults to inserting at the top of the stack", () => {
      const draft = makeDraft([visualTrack("v1")]);
      insertAdjustmentTrackInDraft(draft);
      expect(draft.tracks[0].type).toBe("adjustment");
    });
  });

  describe("createAdjustmentClipInDraft", () => {
    it("creates a clip on an existing adjustment track", () => {
      const draft = makeDraft([adjustmentTrack("adj"), visualTrack("v")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      expect(id).not.toBeNull();
      const clip = draft.clips.find((c) => c.id === id);
      expect(clip).toBeDefined();
      expect(clip!.type).toBe("adjustment");
      expect((clip as AdjustmentTimelineClip).depth).toBe(2);
    });

    it("auto-inserts an adjustment track when trackId is omitted and none exists", () => {
      const draft = makeDraft([visualTrack("v1")]);
      const id = createAdjustmentClipInDraft(draft, {
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      expect(id).not.toBeNull();
      // maybeTrimAndPadTracks slots a padding lane above the inserted
      // adjustment track, so `tracks[0]` isn't necessarily the adjustment.
      // Find it by type and verify the clip references it.
      const adjTracks = draft.tracks.filter((t) => t.type === "adjustment");
      expect(adjTracks).toHaveLength(1);
      const clip = draft.clips.find((c) => c.id === id)!;
      expect(clip.trackId).toBe(adjTracks[0].id);
    });

    it("reuses an existing adjustment track when trackId is omitted", () => {
      const draft = makeDraft([adjustmentTrack("adj"), visualTrack("v")]);
      const id = createAdjustmentClipInDraft(draft, {
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      expect(draft.tracks.filter((t) => t.type === "adjustment")).toHaveLength(
        1,
      );
      const clip = draft.clips.find((c) => c.id === id)!;
      expect(clip.trackId).toBe("adj");
    });

    it("rejects depth < 1", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      expect(
        createAdjustmentClipInDraft(draft, {
          trackId: "adj",
          start: 0,
          timelineDuration: 100,
          depth: 0,
        }),
      ).toBeNull();
      expect(draft.clips).toEqual([]);
    });

    it("rejects non-positive timelineDuration", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      expect(
        createAdjustmentClipInDraft(draft, {
          trackId: "adj",
          start: 0,
          timelineDuration: 0,
          depth: 1,
        }),
      ).toBeNull();
    });

    it("rejects negative start", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      expect(
        createAdjustmentClipInDraft(draft, {
          trackId: "adj",
          start: -1,
          timelineDuration: 100,
          depth: 1,
        }),
      ).toBeNull();
    });

    it("rejects when trackId points at a non-adjustment track (rule 2)", () => {
      const draft = makeDraft([visualTrack("v")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "v",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      expect(id).toBeNull();
      expect(draft.clips).toEqual([]);
    });
  });

  describe("empty-lane type survival across moves", () => {
    it("an empty adjustment track keeps its `adjustment` type after an unrelated clip move", () => {
      // Layout: [adjustment lane (empty), visual lane with v1].
      const adjId = "adj-lane";
      const draft: TimelineModelState = {
        tracks: [
          { ...adjustmentTrack(adjId) },
          visualTrack("v"),
          visualTrack("v2"),
        ],
        clips: [],
      };
      addClipToDraft(draft, videoClip("v1", "v"));

      // Pre-condition: the explicit adjustment lane exists with type set.
      const adjBefore = draft.tracks.find((t) => t.id === adjId)!;
      expect(adjBefore.type).toBe("adjustment");

      // Move the video clip from v to v2. The empty adjustment lane must
      // not have its type wiped by syncTrackTypesFromClips.
      moveClipsInDraft(draft, [
        { clipId: "v1", start: 0, trackId: "v2" },
      ]);

      const adjAfter = draft.tracks.find((t) => t.id === adjId);
      expect(adjAfter).toBeDefined();
      expect(adjAfter!.type).toBe("adjustment");
    });
  });

  describe("setAdjustmentDepthInDraft", () => {
    it("updates the depth of an existing adjustment clip", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      })!;
      expect(setAdjustmentDepthInDraft(draft, id, 4)).toBe(true);
      const clip = draft.clips.find((c) => c.id === id) as AdjustmentTimelineClip;
      expect(clip.depth).toBe(4);
    });

    it("rejects depth < 1", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      })!;
      expect(setAdjustmentDepthInDraft(draft, id, 0)).toBe(false);
      const clip = draft.clips.find((c) => c.id === id) as AdjustmentTimelineClip;
      expect(clip.depth).toBe(2);
    });

    it("rejects on a non-adjustment clip", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      expect(setAdjustmentDepthInDraft(draft, "v1", 2)).toBe(false);
    });

    it("rejects on an unknown clip id", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      expect(setAdjustmentDepthInDraft(draft, "nope", 2)).toBe(false);
    });
  });
});

