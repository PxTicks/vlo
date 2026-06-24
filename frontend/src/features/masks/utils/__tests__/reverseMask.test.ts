import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClipTransform,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";

const mocks = vi.hoisted(() => ({
  reverseTransformationStack: vi.fn(),
}));

vi.mock(
  "../../../transformations/utils/reverseTransformations",
  () => ({
    reverseTransformationStack: mocks.reverseTransformationStack,
  }),
);

import {
  reverseClipMaskTransformations,
  reverseMaskActiveRange,
  reverseMaskPoints,
  reverseMaskTimelineClip,
} from "../reverseMask";

describe("reverseMask", () => {
  beforeEach(() => {
    mocks.reverseTransformationStack.mockReset();
  });

  it("reflects active ranges around the source duration", () => {
    expect(
      reverseMaskActiveRange(
        { startSourceTicks: 20, endSourceTicks: 60 },
        100,
      ),
    ).toEqual({ startSourceTicks: 40, endSourceTicks: 80 });
  });

  it("reflects and chronologically sorts mask points", () => {
    expect(
      reverseMaskPoints(
        [
          { x: 0.1, y: 0.2, timeTicks: 10, label: 1 },
          { x: 0.3, y: 0.4, timeTicks: 80, label: 0 },
        ],
        100,
      ),
    ).toEqual([
      { x: 0.3, y: 0.4, timeTicks: 20, label: 0 },
      { x: 0.1, y: 0.2, timeTicks: 90, label: 1 },
    ]);
  });

  it("reverses time-bearing mask fields without mutating the source", () => {
    const mask = {
      id: "mask-1",
      activeRange: { startSourceTicks: 10, endSourceTicks: 40 },
      maskPoints: [
        { x: 0, y: 0, timeTicks: 20, label: 1 },
      ],
      sam2GeneratedPointsHash: "old-hash",
    } as unknown as MaskTimelineClip;

    const reversed = reverseMaskTimelineClip(mask, 100);

    expect(reversed).not.toBe(mask);
    expect(reversed.activeRange).toEqual({
      startSourceTicks: 60,
      endSourceTicks: 90,
    });
    expect(reversed.maskPoints?.[0].timeTicks).toBe(80);
    expect(reversed.sam2GeneratedPointsHash).toBe("old-hash");
    expect(mask.activeRange).toEqual({
      startSourceTicks: 10,
      endSourceTicks: 40,
    });
  });

  it("preserves masks with no optional time-bearing fields", () => {
    const mask = { id: "mask-1" } as MaskTimelineClip;
    expect(reverseMaskTimelineClip(mask, 100)).toEqual(mask);
  });

  it("handles absent and empty inline transform stacks", () => {
    expect(reverseClipMaskTransformations(undefined, 100)).toEqual([]);
    const empty: ClipTransform[] = [];
    expect(reverseClipMaskTransformations(empty, 100)).toBe(empty);
    expect(mocks.reverseTransformationStack).not.toHaveBeenCalled();
  });

  it("delegates non-empty inline transform reversal", () => {
    const transforms = [{ type: "position" }] as ClipTransform[];
    const reversed = [{ type: "scale" }] as ClipTransform[];
    mocks.reverseTransformationStack.mockReturnValue(reversed);

    expect(reverseClipMaskTransformations(transforms, 100)).toBe(reversed);
    expect(mocks.reverseTransformationStack).toHaveBeenCalledWith(
      transforms,
      100,
    );
  });
});
