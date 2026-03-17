import { describe, expect, it } from "vitest";
import type { TimelineClip, ClipTransform } from "../../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../../timeline";
import { commitLayoutControlToTransforms } from "../layoutControlCommit";

function createClip(transformations: ClipTransform[] = []): TimelineClip {
  return {
    id: "clip_layout_commit",
    trackId: "track_1",
    type: "video",
    name: "Layout Commit Clip",
    sourceDuration: 10 * TICKS_PER_SECOND,
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    transformations,
  };
}

describe("commitLayoutControlToTransforms", () => {
  it("creates a missing layout transform in default order", () => {
    const clip = createClip([]);
    const result = commitLayoutControlToTransforms({
      clip,
      transforms: [],
      groupId: "position",
      controlName: "x",
      value: 25,
      playheadTicks: 0,
      pointEpsilonTicks: 1,
    });

    expect(result).not.toBeNull();
    expect(result?.wasCreated).toBe(true);
    expect(result?.appendedAtEnd).toBe(true);
    expect(result?.nextTransforms).toEqual([
      expect.objectContaining({
        type: "position",
        parameters: expect.objectContaining({ x: 25, y: 0 }),
      }),
    ]);
  });

  it("materializes spline points when editing at a keyed playhead time", () => {
    const transforms: ClipTransform[] = [
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: { x: 0, y: 0 },
        keyframeTimes: [0, 300],
      },
    ];
    const clip = createClip(transforms);

    const result = commitLayoutControlToTransforms({
      clip,
      transforms,
      groupId: "position",
      controlName: "x",
      value: 30,
      transformId: "position_1",
      playheadTicks: 300,
      pointEpsilonTicks: 1,
    });

    const position = result?.nextTransforms.find(
      (transform) => transform.id === "position_1",
    );
    expect(result?.wasCreated).toBe(false);
    expect(position?.keyframeTimes).toEqual([0, 300]);
    expect(position?.parameters.x).toEqual({
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 300, value: 30 },
      ],
    });
  });
});
