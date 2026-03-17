import { describe, expect, it, vi } from "vitest";
import type { MaskTimelineClip } from "../../../../types/TimelineTypes";
import { createMaskLayoutTransforms } from "../maskFactory";
import { liveParamStore } from "../../../transformations";
import {
  getMaskClipContentSize,
  resolveMaskLayoutStateAtTime,
} from "../maskTimelineClip";

function createMaskClip(
  overrides: Partial<MaskTimelineClip> = {},
): MaskTimelineClip {
  return {
    id: "clip_parent::mask::mask_1",
    trackId: "track_1",
    type: "mask",
    name: "Mask 1",
    sourceDuration: 900,
    start: 120,
    timelineDuration: 640,
    offset: 50,
    transformedDuration: 800,
    transformedOffset: 40,
    croppedSourceDuration: 700,
    transformations: createMaskLayoutTransforms("clip_parent::mask::mask_1", {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    }),
    parentClipId: "clip_parent",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 120,
      baseHeight: 120,
    },
    ...overrides,
  };
}

describe("maskTimelineClip", () => {
  it("clamps mask clip content size to positive values", () => {
    const clip = createMaskClip({
      maskParameters: { baseWidth: 0, baseHeight: -25 },
    });

    expect(getMaskClipContentSize(clip)).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("resolves layout from the mask clip transform stack", () => {
    const clip = createMaskClip({
      transformations: [
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "mask_position",
          type: "position",
          isEnabled: true,
          parameters: {
            x: {
              type: "spline",
              points: [
                { time: 0, value: 0 },
                { time: 200, value: 200 },
              ],
            },
            y: 0,
          },
        },
        {
          id: "mask_scale",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1, y: 1, isLinked: false },
        },
        {
          id: "mask_rotation",
          type: "rotation",
          isEnabled: true,
          parameters: { angle: 0 },
        },
      ],
      transformedOffset: 0,
    });

    // Runtime layout resolution uses the provided clip-local raw time.
    const layout = resolveMaskLayoutStateAtTime(clip, 50);
    expect(layout.x).toBeCloseTo(50, 3);
    expect(layout.y).toBeCloseTo(0, 3);
  });

  it("does not emit live control notifications for runtime layout probes", () => {
    const clip = createMaskClip({
      transformations: [
        {
          id: "mask_position",
          type: "position",
          isEnabled: true,
          parameters: { x: 10, y: 20 },
        },
      ],
    });
    const notifySpy = vi.spyOn(liveParamStore, "notify");

    resolveMaskLayoutStateAtTime(clip, 50);

    expect(notifySpy).not.toHaveBeenCalled();
    notifySpy.mockRestore();
  });
});
