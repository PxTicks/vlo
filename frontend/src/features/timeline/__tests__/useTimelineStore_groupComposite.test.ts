import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import { buildTimelineClipPresentationIndex } from "../utils/clipPresentation";

vi.mock("../../userAssets", () => ({
  deleteAsset: vi.fn(async () => undefined),
}));

import { useTimelineStore } from "../useTimelineStore";

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  type: "visual",
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

function videoClip(id: string, trackId: string, start: number): VideoTimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `asset-${id}`,
    start,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
  };
}

function compositeClip(
  id: string,
  trackId: string,
  start = 0,
): VideoTimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: "Composite",
    assetId: "bake-1",
    compositeId: "composite-asset-1",
    start,
    timelineDuration: 200,
    offset: 0,
    croppedSourceDuration: 200,
    transformedOffset: 0,
    sourceDuration: 200,
    transformedDuration: 200,
    transformations: [],
  };
}

function rippleAdjustmentClip(): AdjustmentTimelineClip {
  const speed: ClipTransform = {
    id: "speed-2x",
    type: "speed",
    isEnabled: true,
    parameters: { factor: 2 },
  };
  return {
    id: "adjustment",
    trackId: "adjustment-track",
    type: "adjustment",
    name: "Adjustment",
    start: 0,
    timelineDuration: TICKS_PER_SECOND,
    sourceDuration: 2 * TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 2 * TICKS_PER_SECOND,
    offset: 0,
    transformations: [speed],
    depth: 1,
    retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
  };
}

describe("useTimelineStore.groupClipsIntoComposite", () => {
  beforeEach(() => {
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1"), createTrack("track-2")],
        clips: [
          videoClip("clip-a", "track-1", 0),
          videoClip("clip-b", "track-2", 100),
        ],
      });
    });
  });

  it("does not wipe the timeline when the whole timeline is grouped", () => {
    const composite = compositeClip("composite-1", "track-1");

    act(() => {
      useTimelineStore
        .getState()
        .groupClipsIntoComposite(["clip-a", "clip-b"], composite);
    });

    const { clips, tracks } = useTimelineStore.getState();

    // The composite must survive and the source clips must be gone.
    expect(clips.map((c) => c.id)).toEqual(["composite-1"]);

    // The composite must live on a track that actually exists, otherwise it is
    // orphaned and the timeline renders empty (the catastrophic wipe).
    const trackIds = new Set(tracks.map((t) => t.id));
    expect(trackIds.has(clips[0].trackId)).toBe(true);
  });

  it("keeps the composite at the selection's presentation start under ripple retiming", () => {
    const targetPresentationStart = 1.5 * TICKS_PER_SECOND;
    const source = videoClip("source", "track-1", 2 * TICKS_PER_SECOND);
    const adjustmentTrack = createTrack("adjustment-track");
    adjustmentTrack.type = "adjustment";

    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [adjustmentTrack, createTrack("track-1")],
        clips: [rippleAdjustmentClip(), source],
      });
    });

    const composite = compositeClip(
      "composite-ripple",
      "track-1",
      targetPresentationStart,
    );
    act(() => {
      useTimelineStore
        .getState()
        .groupClipsIntoComposite([source.id], composite);
    });

    const { clips, tracks } = useTimelineStore.getState();
    const placed = clips.find((clip) => clip.id === composite.id);
    const presentation = buildTimelineClipPresentationIndex(
      tracks,
      clips,
      30,
    ).get(composite.id);

    expect(placed?.start).toBeGreaterThan(targetPresentationStart);
    expect(presentation?.start).toBe(targetPresentationStart);
  });

  it("keeps bake publication inside the original grouping undo step", () => {
    const composite = compositeClip("composite-1", "track-1");

    act(() => {
      useTimelineStore
        .getState()
        .groupClipsIntoComposite(["clip-a", "clip-b"], composite);
      useTimelineStore
        .getState()
        .syncCompositePlacementRevision(
          "composite-asset-1",
          1,
          "bake-current",
        );
    });

    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        id: composite.id,
        assetId: "bake-current",
      }),
    ]);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      "clip-a",
      "clip-b",
    ]);

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({ id: composite.id }),
    ]);
  });

  it("extracts only the selected middle of a clip and leaves both sides behind", () => {
    const source = videoClip("source", "track-1", 0);
    source.timelineDuration = 300;
    source.croppedSourceDuration = 300;
    source.sourceDuration = 300;
    source.transformedDuration = 300;
    const composite = compositeClip("composite-middle", "track-1", 100);
    composite.timelineDuration = 100;

    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1")],
        clips: [source],
      });
    });
    const beforeGrouping = structuredClone(useTimelineStore.getState().clips);

    act(() => {
      useTimelineStore.getState().groupClipsIntoComposite(
        [source.id],
        composite,
        { start: 100, end: 200 },
      );
    });

    const grouped = useTimelineStore.getState().clips;
    expect(grouped).toHaveLength(3);
    expect(grouped).toContainEqual(
      expect.objectContaining({
        id: source.id,
        start: 0,
        timelineDuration: 100,
        offset: 0,
      }),
    );
    expect(grouped).toContainEqual(
      expect.objectContaining({
        id: composite.id,
        start: 100,
        timelineDuration: 100,
      }),
    );
    expect(grouped).toContainEqual(
      expect.objectContaining({
        assetId: source.assetId,
        start: 200,
        timelineDuration: 100,
        offset: 200,
      }),
    );

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toEqual(beforeGrouping);

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(3);
  });
});
