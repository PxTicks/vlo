import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  AdjustmentRetimingMode,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../../types/TimelineTypes";
import { buildTimelineClipPresentationIndex } from "../../utils/clipPresentation";
import { mapSourceTimeToVisualTime } from "../../../transformations";
import { TICKS_PER_SECOND } from "../../constants";
import {
  resolveClipsAtPlayhead,
  resolveMarkerPlacementsAtPlayhead,
  resolveSplitPointsAtPlayhead,
} from "../playheadPlacement";
import { splitClipInDraft } from "../timelineCommands";

// One tick per frame makes frame quantization an identity on integers, so the
// assertions below exercise placement, not snapping (see clipPresentation.test).
const GRID_FPS = TICKS_PER_SECOND;

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

function speedTransform(factor: number): ClipTransform {
  return {
    id: `speed-${factor}`,
    type: "speed",
    isEnabled: true,
    parameters: { factor },
  };
}

function adjustmentClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
  sourceDuration?: number;
  depth: number;
  retimingMode?: AdjustmentRetimingMode;
  transformations?: ClipTransform[];
}): AdjustmentTimelineClip {
  const sourceDuration = overrides.sourceDuration ?? overrides.timelineDuration;
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: sourceDuration,
    offset: 0,
    transformations: overrides.transformations ?? [],
    depth: overrides.depth,
    retimingMode: overrides.retimingMode,
  };
}

function videoClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
}): TimelineClip {
  return {
    id: overrides.id,
    type: "video",
    name: overrides.id,
    trackId: overrides.trackId,
    assetId: `asset-${overrides.id}`,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration: overrides.timelineDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: overrides.timelineDuration,
    offset: 0,
    transformations: [],
  };
}

/**
 * Where the overlay draws a marker: source time pushed back to clip-local
 * visual time, then out to the clip's presentation footprint — the same chain
 * `TimelineClipOverlayLayer` uses for a `sourceTime` placement.
 */
function renderedPresentationTick(
  tracks: TimelineTrack[],
  clips: TimelineClip[],
  clipId: string,
  sourceTimeTicks: number,
): number {
  const clip = clips.find((candidate) => candidate.id === clipId)!;
  const presentation = buildTimelineClipPresentationIndex(
    tracks,
    clips,
    GRID_FPS,
  ).get(clipId);
  const visualTicks = mapSourceTimeToVisualTime(clip, sourceTimeTicks);
  return (
    (presentation?.start ?? clip.start) +
    (presentation?.mapClipOffsetToPresentationOffset(visualTicks) ?? visualTicks)
  );
}

describe("resolveClipsAtPlayhead", () => {
  const tracks = [visualTrack("v1")];
  const parent = videoClip({
    id: "video-1",
    trackId: "v1",
    start: 0,
    timelineDuration: 40,
  });
  const maskChild: TimelineClip = {
    ...parent,
    id: "video-1::mask-1",
    type: "mask",
    parentClipId: "video-1",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
  };
  const clips = [parent, maskChild];

  it("drops mask children by default — markers and beats edit the clip itself", () => {
    const covered = resolveClipsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 10,
    });

    expect(covered.map((clip) => clip.id)).toEqual(["video-1"]);
  });

  it("keeps mask children of a covered parent when asked", () => {
    // `getTimelineClipsInPresentationRange` relies on this: selection and
    // composite grouping must carry a clip's masks with it.
    const covered = resolveClipsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 10,
      includeMaskChildren: true,
    });

    expect(covered.map((clip) => clip.id)).toEqual([
      "video-1",
      "video-1::mask-1",
    ]);
  });
});

describe("resolveMarkerPlacementsAtPlayhead", () => {
  it("anchors a marker to the clip under the playhead", () => {
    const tracks = [visualTrack("v1")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
      videoClip({ id: "video-2", trackId: "v1", start: 40, timelineDuration: 40 }),
    ];

    const placements = resolveMarkerPlacementsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 55,
    });

    expect(placements).toEqual([{ clipId: "video-2", sourceTimeTicks: 15 }]);
    expect(
      renderedPresentationTick(tracks, clips, "video-2", 15),
    ).toBe(55);
  });

  it("anchors to presentation time for a clip rippled by an upstream retime", () => {
    // A 2x ripple adjustment over [0, 50) pulls `video-1` (stored start 120)
    // forward to a footprint of [70, 90). Reading the playhead against the
    // stored start would place the marker 50 ticks late.
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        transformations: [speedTransform(2)],
      }),
      videoClip({ id: "video-1", trackId: "v1", start: 120, timelineDuration: 20 }),
    ];

    const placements = resolveMarkerPlacementsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 75,
    });

    expect(placements).toEqual([{ clipId: "video-1", sourceTimeTicks: 5 }]);
    // The marker draws back exactly under the playhead that created it.
    expect(renderedPresentationTick(tracks, clips, "video-1", 5)).toBe(75);
  });

  it("ignores clips whose stored span covers the playhead but whose footprint does not", () => {
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        transformations: [speedTransform(2)],
      }),
      videoClip({ id: "video-1", trackId: "v1", start: 120, timelineDuration: 20 }),
    ];

    // 130 is inside the stored span [120, 140) but the clip is drawn at
    // [70, 90), so nothing on the visual track is under the playhead.
    const placements = resolveMarkerPlacementsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 130,
    });

    expect(placements.map((placement) => placement.clipId)).not.toContain(
      "video-1",
    );
  });

  it("prefers selected clips when several are under the playhead", () => {
    const tracks = [visualTrack("v1"), visualTrack("v2")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
      videoClip({ id: "video-2", trackId: "v2", start: 0, timelineDuration: 40 }),
    ];

    const placements = resolveMarkerPlacementsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 10,
      preferredClipIds: ["video-2"],
    });

    expect(placements).toEqual([{ clipId: "video-2", sourceTimeTicks: 10 }]);
  });

  it("falls back to every covered clip when the selection is elsewhere", () => {
    const tracks = [visualTrack("v1")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
      videoClip({ id: "video-2", trackId: "v1", start: 40, timelineDuration: 40 }),
    ];

    const placements = resolveMarkerPlacementsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 10,
      preferredClipIds: ["video-2"],
    });

    expect(placements.map((placement) => placement.clipId)).toEqual(["video-1"]);
  });
});

describe("resolveSplitPointsAtPlayhead", () => {
  it("cuts at the playhead when nothing retimes the clip", () => {
    const tracks = [visualTrack("v1")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
      videoClip({ id: "video-2", trackId: "v1", start: 40, timelineDuration: 40 }),
    ];

    expect(
      resolveSplitPointsAtPlayhead({
        tracks,
        clips,
        fps: GRID_FPS,
        presentationTick: 55,
      }),
    ).toEqual([{ clipId: "video-2", splitTick: 55 }]);
  });

  it("converts the playhead to stored time for a clip moved by a ripple retime", () => {
    // 2x ripple over [0, 50) draws `video-1` (stored 120..140) at 70..90.
    // A playhead at 75 is 5 ticks into the clip, so the stored cut is 125 —
    // handing the model the raw 75 would trip its bounds guard instead.
    const tracks = [adjustmentTrack("adj"), visualTrack("v1")];
    const clips: TimelineClip[] = [
      adjustmentClip({
        id: "adj-1",
        trackId: "adj",
        start: 0,
        timelineDuration: 50,
        sourceDuration: 100,
        depth: 1,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        transformations: [speedTransform(2)],
      }),
      videoClip({ id: "video-1", trackId: "v1", start: 120, timelineDuration: 20 }),
    ];

    const [splitPoint, ...rest] = resolveSplitPointsAtPlayhead({
      tracks,
      clips,
      fps: GRID_FPS,
      presentationTick: 75,
    });

    expect(rest).toEqual([]);
    expect(splitPoint).toEqual({ clipId: "video-1", splitTick: 125 });

    // The model accepts it and cuts where the user aimed: 5 ticks in.
    const draft = { tracks, clips: [...clips], transitions: [] };
    const rightClipId = splitClipInDraft(
      draft,
      splitPoint.clipId,
      splitPoint.splitTick,
    );
    expect(rightClipId).not.toBeNull();
    const left = draft.clips.find((clip) => clip.id === "video-1");
    expect(left?.timelineDuration).toBe(5);
  });

  it("drops cuts that would land on a clip edge", () => {
    const tracks = [visualTrack("v1")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
    ];

    // The model rejects a cut at either boundary, so it never gets one.
    expect(
      resolveSplitPointsAtPlayhead({
        tracks,
        clips,
        fps: GRID_FPS,
        presentationTick: 0,
      }),
    ).toEqual([]);
  });

  it("restricts the cut to selected clips, with no fallback", () => {
    const tracks = [visualTrack("v1"), visualTrack("v2")];
    const clips = [
      videoClip({ id: "video-1", trackId: "v1", start: 0, timelineDuration: 40 }),
      videoClip({ id: "video-2", trackId: "v2", start: 0, timelineDuration: 40 }),
    ];

    // Razor mode (no selection) cuts everything the playhead covers.
    expect(
      resolveSplitPointsAtPlayhead({
        tracks,
        clips,
        fps: GRID_FPS,
        presentationTick: 10,
      }).map((point) => point.clipId),
    ).toEqual(["video-1", "video-2"]);

    // A selection narrows it...
    expect(
      resolveSplitPointsAtPlayhead({
        tracks,
        clips,
        fps: GRID_FPS,
        presentationTick: 10,
        selectedClipIds: ["video-2"],
      }),
    ).toEqual([{ clipId: "video-2", splitTick: 10 }]);

    // ...and a selection the playhead misses cuts nothing, rather than
    // falling back to every covered clip the way markers do.
    expect(
      resolveSplitPointsAtPlayhead({
        tracks,
        clips,
        fps: GRID_FPS,
        presentationTick: 10,
        selectedClipIds: ["video-3"],
      }),
    ).toEqual([]);
  });
});
