import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdjustmentDepth,
  AdjustmentTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_RIPPLE,
  ADJUSTMENT_RETIMING_STATIC,
} from "../../../../types/TimelineTypes";
import {
  createAdjustmentClipInDraft,
  insertAdjustmentTrackInDraft,
  setAdjustmentDepthInDraft,
  setAdjustmentRetimingModeInDraft,
} from "../adjustmentClipCommands";
import {
  addClipToDraft,
  moveClipsInDraft,
  addClipTransformToDraft,
  removeClipIdsFromDraft,
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
  depth?: AdjustmentDepth;
  sourceDuration?: number;
}): AdjustmentTimelineClip {
  const timelineDuration = overrides.timelineDuration ?? 100;
  const sourceDuration = overrides.sourceDuration ?? timelineDuration;
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start ?? 0,
    timelineDuration,
    sourceDuration,
    transformedDuration: timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: sourceDuration,
    offset: 0,
    transformations: [],
    depth: overrides.depth ?? 1,
  };
}

describe("track-type compatibility (general)", () => {
  // The store-layer enforcement is type-agnostic: populated typed tracks only
  // accept clips whose `getTrackTypeFromClipType` matches their type. Empty
  // tracks are flexible and acquire the type of the next non-mask clip.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("addClipToDraft", () => {
    it("rejects a video clip on a populated adjustment track", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      addClipToDraft(draft, videoClip("v1", "adj"));
      expect(draft.clips.map((clip) => clip.id)).toEqual(["a"]);
    });

    it("rejects an adjustment clip on a populated visual track", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      addClipToDraft(draft, adjustmentClip({ id: "adj1", trackId: "v" }));
      expect(draft.clips.map((clip) => clip.id)).toEqual(["v1"]);
    });

    it("accepts any clip on an empty typed track and retargets the track type", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, videoClip("v1", "adj"));

      expect(draft.clips).toHaveLength(1);
      expect(draft.tracks.find((track) => track.id === "adj")?.type).toBe(
        "visual",
      );
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
      addClipToDraft(draft, videoClip("v1", "v"));
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
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
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

  describe("speed transforms on adjustment clips", () => {
    it("addClipTransformToDraft accepts a speed transform on an adjustment clip", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      addClipTransformToDraft(draft, "a", {
        id: "speed-1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2 },
      });
      const a = draft.clips.find((c) => c.id === "a")!;
      expect(a.transformations.find((t) => t.type === "speed")).toBeTruthy();
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

    it("setClipTransformsAndShapeInDraft accepts a batch containing speed on an adjustment", () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));
      // First add a valid transform.
      addClipTransformToDraft(draft, "a", {
        id: "pos-1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 20 },
      });
      // Bulk-replace including a speed transform.
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
      expect(a.transformations).toHaveLength(2);
      expect(a.transformations.map((transform) => transform.id)).toEqual([
        "pos-2",
        "speed-1",
      ]);
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
      expect(clip).toMatchObject({
        type: "adjustment",
        sourceDuration: 100,
        croppedSourceDuration: 100,
        timelineDuration: 100,
        transformedDuration: 100,
        transformedOffset: 0,
        offset: 0,
      });
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

    it('defaults depth to the "all" sentinel', () => {
      const draft = makeDraft([
        adjustmentTrack("adj"),
        visualTrack("v1"),
        visualTrack("v2"),
        visualTrack("v3"),
      ]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
      });

      expect(id).not.toBeNull();
      const clip = draft.clips.find((c) => c.id === id) as AdjustmentTimelineClip;
      expect(clip.depth).toBe(ADJUSTMENT_DEPTH_ALL);
    });

    it("defaults retiming to static/pinned mode", () => {
      const draft = makeDraft([adjustmentTrack("adj"), visualTrack("v1")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
      });

      const clip = draft.clips.find((c) => c.id === id) as AdjustmentTimelineClip;
      expect(clip.retimingMode).toBe(ADJUSTMENT_RETIMING_STATIC);
    });

    it("updates adjustment retiming mode", () => {
      const draft = makeDraft([adjustmentTrack("adj"), visualTrack("v1")]);
      addClipToDraft(draft, adjustmentClip({ id: "a", trackId: "adj" }));

      expect(
        setAdjustmentRetimingModeInDraft(
          draft,
          "a",
          ADJUSTMENT_RETIMING_RIPPLE,
        ),
      ).toBe(true);
      expect((draft.clips[0] as AdjustmentTimelineClip).retimingMode).toBe(
        ADJUSTMENT_RETIMING_RIPPLE,
      );
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

    it("rejects when trackId points at a populated non-adjustment track", () => {
      const draft = makeDraft([visualTrack("v")]);
      addClipToDraft(draft, videoClip("v1", "v"));
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "v",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      expect(id).toBeNull();
      expect(draft.clips.map((clip) => clip.id)).toEqual(["v1"]);
    });
  });

  describe("empty adjustment lane cleanup", () => {
    it("clears the adjustment type after removing the last adjustment clip from a track", () => {
      const draft: TimelineModelState = {
        tracks: [visualTrack("v"), adjustmentTrack("adj")],
        clips: [
          videoClip("v1", "v"),
          adjustmentClip({ id: "a", trackId: "adj" }),
        ],
      };

      removeClipIdsFromDraft(draft, new Set(["a"]));

      const emptiedTrack = draft.tracks.find((track) => track.id === "adj");
      expect(emptiedTrack).toBeDefined();
      expect(emptiedTrack!.type).toBeUndefined();

      addClipToDraft(draft, videoClip("v2", "adj"));
      expect(draft.clips.find((clip) => clip.id === "v2")).toBeDefined();
    });

    it("clears and trims the source track when moving its last adjustment clip away", () => {
      const draft: TimelineModelState = {
        tracks: [
          adjustmentTrack("source"),
          {
            id: "target",
            label: "target",
            isVisible: true,
            isMuted: false,
            isLocked: false,
          },
          visualTrack("v"),
        ],
        clips: [
          adjustmentClip({ id: "a", trackId: "source" }),
          videoClip("v1", "v"),
        ],
      };

      moveClipsInDraft(draft, [
        { clipId: "a", start: 0, trackId: "target" },
      ]);

      const sourceTrack = draft.tracks.find((track) => track.id === "source");
      expect(sourceTrack).toBeDefined();
      expect(sourceTrack!.type).toBeUndefined();
      expect(draft.tracks.find((track) => track.id === "target")?.type).toBe(
        "adjustment",
      );
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

    it('updates the depth of an existing adjustment clip to the "all" sentinel', () => {
      const draft = makeDraft([adjustmentTrack("adj")]);
      const id = createAdjustmentClipInDraft(draft, {
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      })!;
      expect(setAdjustmentDepthInDraft(draft, id, ADJUSTMENT_DEPTH_ALL)).toBe(
        true,
      );
      const clip = draft.clips.find((c) => c.id === id) as AdjustmentTimelineClip;
      expect(clip.depth).toBe(ADJUSTMENT_DEPTH_ALL);
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
