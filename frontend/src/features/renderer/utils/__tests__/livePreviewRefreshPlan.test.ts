import { describe, expect, it } from "vitest";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { createLivePreviewRefreshPlan } from "../livePreviewRefreshPlan";

function createClip(): TimelineClip {
  return {
    id: "clip",
    trackId: "track",
    type: "video",
    assetId: "asset",
    name: "Clip",
    start: 0,
    timelineDuration: 100,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [
      {
        id: "clip-position",
        type: "position",
        isEnabled: true,
        parameters: { x: 0, y: 0 },
      },
      {
        id: "clip-speed",
        type: "speed",
        isEnabled: true,
        parameters: { speed: 1 },
      },
    ],
    components: [
      {
        id: "mask-composition",
        type: "mask_composition",
        isEnabled: true,
        parameters: {
          expression: { kind: "mask_ref", maskId: "mask" },
          expressionEnabled: true,
          compositeTransformations: [
            {
              id: "mask-grow",
              type: "mask_grow",
              isEnabled: true,
              parameters: { amount: 0 },
            },
          ],
        },
      },
    ],
  };
}

function createMask(): MaskTimelineClip {
  return {
    id: "clip::mask::mask",
    trackId: "track",
    type: "mask",
    name: "Mask",
    start: 0,
    timelineDuration: 100,
    sourceDuration: null,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    offset: 0,
    parentClipId: "clip",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: true,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
    transformations: [
      {
        id: "mask-position",
        type: "position",
        isEnabled: true,
        parameters: { x: 0, y: 0 },
      },
      {
        id: "mask-opacity",
        type: "opacity",
        isEnabled: true,
        parameters: { opacity: 1 },
      },
    ],
  };
}

function setChange(transformId: string) {
  return {
    kind: "set" as const,
    parameters: [{ transformId, paramName: "value" }],
  };
}

describe("createLivePreviewRefreshPlan", () => {
  const clip = createClip();
  const mask = createMask();

  it("keeps clip and mask layout transforms on resident Pixi objects", () => {
    expect(
      createLivePreviewRefreshPlan(setChange("clip-position"), clip, [mask]),
    ).toEqual({
      updateClipTransforms: true,
      maskClipIds: new Set(),
      needsFrameGraphRefresh: false,
    });
    expect(
      createLivePreviewRefreshPlan(setChange("mask-position"), clip, [mask]),
    ).toEqual({
      updateClipTransforms: false,
      maskClipIds: new Set([mask.id]),
      needsFrameGraphRefresh: false,
    });
  });

  it("routes source, mask-content, and composite changes through the frame graph", () => {
    for (const transformId of [
      "clip-speed",
      "mask-opacity",
      "mask-grow",
    ]) {
      expect(
        createLivePreviewRefreshPlan(setChange(transformId), clip, [mask])
          ?.needsFrameGraphRefresh,
      ).toBe(true);
    }
  });

  it("ignores changes owned by another active track", () => {
    expect(
      createLivePreviewRefreshPlan(setChange("other-transform"), clip, [mask]),
    ).toBeNull();
  });
});
