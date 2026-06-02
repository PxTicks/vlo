import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  createEndpointOverlayItem,
  createLayerTimeOverlayItem,
  createSourceTimeOverlayItem,
  getPrimaryActiveClip,
  getTimelineClipById,
  getTimelineClipCountForAsset,
  getTimelineClipsForTrack,
  getTimelineDuration,
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
  useTimelineStore,
  TICKS_PER_SECOND,
} from "..";
import { useProjectStore } from "../../project/useProjectStore";

const TRACKS: TimelineTrack[] = [
  {
    id: "track-video",
    label: "Video",
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "visual",
  },
  {
    id: "track-audio",
    label: "Audio",
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "audio",
  },
];

const CLIPS: TimelineClip[] = [
  {
    id: "clip-video",
    trackId: "track-video",
    type: "video",
    name: "Video Clip",
    assetId: "asset-video",
    sourceDuration: 200,
    timelineDuration: 100,
    croppedSourceDuration: 200,
    start: 10,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    transformations: [],
  },
  {
    id: "clip-mask",
    trackId: "track-video",
    type: "mask",
    name: "Mask Clip",
    sourceDuration: 100,
    timelineDuration: 40,
    croppedSourceDuration: 100,
    start: 20,
    offset: 0,
    transformedDuration: 40,
    transformedOffset: 0,
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
    transformations: [],
  },
  {
    id: "clip-audio",
    trackId: "track-audio",
    type: "audio",
    name: "Audio Clip",
    assetId: "asset-audio",
    sourceDuration: 300,
    timelineDuration: 150,
    croppedSourceDuration: 300,
    start: 50,
    offset: 0,
    transformedDuration: 150,
    transformedOffset: 0,
    transformations: [],
  },
  {
    id: "clip-text",
    trackId: "track-video",
    type: "text",
    name: "Text Clip",
    sourceDuration: null,
    timelineDuration: 80,
    croppedSourceDuration: 80,
    start: 120,
    offset: 0,
    transformedDuration: 80,
    transformedOffset: 0,
    transformations: [],
    textData: {
      content: "Hello",
      fontFamily: "Arial",
      fontSize: 48,
      fill: "#ffffff",
      align: "center",
      strokeColor: "#000000",
      strokeWidth: 0,
    },
  },
];

describe("timeline public API", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: TRACKS,
      clips: CLIPS,
      selectedClipIds: ["clip-video"],
    });
    // Drive the frame grid at one tick per frame so the abstract tick fixtures
    // here are already frame-aligned (quantization is identity); the duration
    // assertions then test selector plumbing, not frame snapping.
    useProjectStore.setState((s) => ({
      config: { ...s.config, fps: TICKS_PER_SECOND },
    }));
  });

  it("exposes clip lookups through selectors and getters", () => {
    const state = useTimelineStore.getState();

    expect(selectTimelineClipById(state, "clip-video")?.id).toBe("clip-video");
    expect(selectPrimaryActiveClip(state)?.id).toBe("clip-video");
    expect(getTimelineClipById("clip-audio")?.id).toBe("clip-audio");
    expect(getPrimaryActiveClip()?.id).toBe("clip-video");
  });

  it("exposes track clips, duration, and asset usage through public helpers", () => {
    const state = useTimelineStore.getState();

    expect(selectTimelineClipsForTrack(state, "track-video")).toHaveLength(3);
    expect(
      selectTimelineClipsForTrack(state, "track-video", false),
    ).toHaveLength(2);
    expect(getTimelineClipsForTrack("track-video", false)).toHaveLength(2);

    expect(selectTimelineDuration(state, TICKS_PER_SECOND)).toBe(200);
    expect(getTimelineDuration()).toBe(200);

    expect(selectTimelineClipCountForAsset(state, "asset-video")).toBe(1);
    expect(getTimelineClipCountForAsset("asset-audio")).toBe(1);
    expect(getTimelineClipCountForAsset("asset-text")).toBe(0);
    expect(getTimelineClipCountForAsset("missing")).toBe(0);
  });

  it("exposes clip overlay builders through the timeline public API", () => {
    expect(typeof createEndpointOverlayItem).toBe("function");
    expect(typeof createSourceTimeOverlayItem).toBe("function");
    expect(typeof createLayerTimeOverlayItem).toBe("function");

    expect(
      createEndpointOverlayItem({
        id: "endpoint-item",
        edge: "start",
        content: "endpoint",
      }).placement,
    ).toMatchObject({
      kind: "endpoint",
      edge: "start",
      lane: "middle",
      insetPx: 8,
      order: 0,
    });
  });
});

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
  start: number;
  timelineDuration: number;
  sourceDuration: number;
  factor: number;
}): AdjustmentTimelineClip {
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: "track-adjustment",
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration: overrides.sourceDuration,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: overrides.sourceDuration,
    offset: 0,
    transformations: [speedTransform(overrides.factor)],
    depth: 1,
  };
}

function affectedVideoClip(timelineDuration: number): TimelineClip {
  return {
    id: "clip-under-adjustment",
    trackId: "track-under",
    type: "video",
    name: "Under Adjustment",
    assetId: "asset-video",
    sourceDuration: timelineDuration,
    timelineDuration,
    croppedSourceDuration: timelineDuration,
    start: 0,
    offset: 0,
    transformedDuration: timelineDuration,
    transformedOffset: 0,
    transformations: [],
  };
}

// An adjustment track must sit above the track it retimes.
const ADJUSTMENT_TRACKS: TimelineTrack[] = [
  {
    id: "track-adjustment",
    label: "Adjustment",
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "adjustment",
  },
  {
    id: "track-under",
    label: "Under",
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "visual",
  },
];

describe("timeline duration under adjustment-speed retiming", () => {
  it("extends past the stored end when a slow ramp expands a clip past its source window", () => {
    // 0.5x adjustment: source window [0, 100) stretched to presentation [0, 200).
    // The clip is 150 ticks, so its tail (stored [100, 150)) carries forward to
    // presentation [200, 250). Stored max end is the adjustment's 200, but the
    // clip actually renders out to 250.
    useTimelineStore.setState({
      tracks: ADJUSTMENT_TRACKS,
      clips: [
        adjustmentClip({
          id: "adj-slow",
          start: 0,
          timelineDuration: 200,
          sourceDuration: 100,
          factor: 0.5,
        }),
        affectedVideoClip(150),
      ],
      selectedClipIds: [],
    });

    expect(getTimelineDuration()).toBe(250);
  });

  it("trims trailing dead air when a fast ramp compresses a clip", () => {
    // 2x adjustment: stored clip [0, 100) compresses to presentation [0, 50).
    // The old stored-end computation reported 100 (50 ticks of dead air).
    useTimelineStore.setState({
      tracks: ADJUSTMENT_TRACKS,
      clips: [
        adjustmentClip({
          id: "adj-fast",
          start: 0,
          timelineDuration: 50,
          sourceDuration: 100,
          factor: 2,
        }),
        affectedVideoClip(100),
      ],
      selectedClipIds: [],
    });

    expect(getTimelineDuration()).toBe(50);
  });
});
