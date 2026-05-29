import { describe, expect, it } from "vitest";
import type {
  BaseClip,
  MaskTimelineClip,
  StandardTimelineClip,
} from "../TimelineTypes";
import {
  isAssetBackedClip,
  isMaskClip,
  isNonMaskTimelineClip,
  isTextClip,
} from "../TimelineTypes";

const VIDEO_CLIP: BaseClip = {
  id: "clip-video",
  type: "video",
  name: "Video",
  assetId: "asset-video",
  sourceDuration: 120,
  timelineDuration: 120,
  croppedSourceDuration: 120,
  offset: 0,
  transformedDuration: 120,
  transformedOffset: 0,
  transformations: [],
};

const TEXT_CLIP: BaseClip = {
  id: "clip-text",
  type: "text",
  name: "Text",
  sourceDuration: null,
  timelineDuration: 90,
  croppedSourceDuration: 90,
  offset: 0,
  transformedDuration: 90,
  transformedOffset: 0,
  transformations: [],
  textData: {
    content: "Hello world",
    fontFamily: "Arial",
    fontSize: 42,
    fill: "#ffffff",
    align: "center",
    strokeColor: "#000000",
    strokeWidth: 0,
  },
};

const TIMELINE_VIDEO_CLIP: StandardTimelineClip = {
  ...VIDEO_CLIP,
  trackId: "track-1",
  start: 0,
};

const MASK_CLIP: MaskTimelineClip = {
  id: "mask-1",
  type: "mask",
  name: "Mask",
  trackId: "track-1",
  start: 0,
  sourceDuration: 120,
  timelineDuration: 120,
  croppedSourceDuration: 120,
  offset: 0,
  transformedDuration: 120,
  transformedOffset: 0,
  transformations: [],
  maskType: "rectangle",
  maskMode: "apply",
  maskInverted: false,
  maskParameters: { baseWidth: 100, baseHeight: 100 },
};

describe("TimelineTypes guards", () => {
  it("identifies asset-backed clips without treating text or masks as asset-backed", () => {
    expect(isAssetBackedClip(VIDEO_CLIP)).toBe(true);
    expect(isAssetBackedClip(TEXT_CLIP)).toBe(false);
    expect(isAssetBackedClip(MASK_CLIP)).toBe(false);
  });

  it("identifies text and mask variants correctly", () => {
    expect(isTextClip(TEXT_CLIP)).toBe(true);
    expect(isTextClip(VIDEO_CLIP)).toBe(false);
    expect(isMaskClip(MASK_CLIP)).toBe(true);
    expect(isMaskClip(TIMELINE_VIDEO_CLIP)).toBe(false);
  });

  it("identifies non-mask timeline clips", () => {
    expect(isNonMaskTimelineClip(TIMELINE_VIDEO_CLIP)).toBe(true);
    expect(isNonMaskTimelineClip(MASK_CLIP)).toBe(false);
  });
});
