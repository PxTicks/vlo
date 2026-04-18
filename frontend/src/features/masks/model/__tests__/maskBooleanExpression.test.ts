import { describe, expect, it } from "vitest";
import type {
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../../types/TimelineTypes";
import {
  resolveMaskBooleanExpression,
  resolveRenderableMaskBooleanExpression,
} from "../maskBooleanExpression";

function createMaskClip(
  parentClipId: string,
  localId: string,
  mode: MaskTimelineClip["maskMode"] = "apply",
): MaskTimelineClip {
  return {
    id: `${parentClipId}::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId,
    maskType: "rectangle",
    maskMode: mode,
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
  };
}

describe("maskBooleanExpression helpers", () => {
  it("renderable expression matches the resolved editor expression", () => {
    const parent: Pick<StandardTimelineClip, "maskBooleanExpression"> = {
      maskBooleanExpression: {
        kind: "operation",
        operator: "intersect",
        left: {
          kind: "mask_ref",
          maskId: "mask_a",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_b",
        },
      },
    };
    const maskA = createMaskClip("clip_1", "mask_a", "apply");
    const maskB = createMaskClip("clip_1", "mask_b", "preview");

    const expected = {
      kind: "operation",
      operator: "intersect",
      left: {
        kind: "mask_ref",
        maskId: "mask_a",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_b",
      },
    };

    expect(resolveMaskBooleanExpression(parent, [maskA, maskB])).toEqual(expected);
    expect(resolveRenderableMaskBooleanExpression(parent, [maskA, maskB])).toEqual(
      expected,
    );
  });
});
