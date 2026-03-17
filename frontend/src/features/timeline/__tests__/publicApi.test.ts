import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
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
} from "..";

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
];

describe("timeline public API", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: TRACKS,
      clips: CLIPS,
      selectedClipIds: ["clip-video"],
    });
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

    expect(selectTimelineClipsForTrack(state, "track-video")).toHaveLength(2);
    expect(selectTimelineClipsForTrack(state, "track-video", false)).toHaveLength(1);
    expect(getTimelineClipsForTrack("track-video", false)).toHaveLength(1);

    expect(selectTimelineDuration(state)).toBe(200);
    expect(getTimelineDuration()).toBe(200);

    expect(selectTimelineClipCountForAsset(state, "asset-video")).toBe(1);
    expect(getTimelineClipCountForAsset("asset-audio")).toBe(1);
    expect(getTimelineClipCountForAsset("missing")).toBe(0);
  });
});
