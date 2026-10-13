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
    assetId: "asset_clip_layout_commit",
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

  describe("shared layout keyframe track", () => {
    it("keys every layout transform when scale is edited against keyed position", () => {
      const transforms: ClipTransform[] = [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: {
            x: {
              type: "spline",
              points: [
                { time: 0, value: 0 },
                { time: 300, value: 300 },
              ],
            },
            y: 0,
          },
          keyframeTimes: [0, 300],
        },
        {
          id: "scale_1",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1.5, y: 1.5, isLinked: false },
        },
      ];

      const result = commitLayoutControlToTransforms({
        clip: createClip(transforms),
        transforms,
        groupId: "scale",
        controlName: "x",
        value: 2,
        playheadTicks: 150,
        pointEpsilonTicks: 1,
      });

      expect(result?.changedOtherTransforms).toBe(true);
      const [position, scale] = result!.nextTransforms;
      // Scale changes only at the playhead; it holds 1.5 at the other keys.
      expect(scale.keyframeTimes).toEqual([0, 150, 300]);
      expect(scale.parameters.x).toEqual({
        type: "spline",
        points: [
          { time: 0, value: 1.5 },
          { time: 150, value: 2 },
          { time: 300, value: 1.5 },
        ],
      });
      // Position gets a key at the playhead holding its current value.
      expect(position.keyframeTimes).toEqual([0, 150, 300]);
      expect(position.parameters.x).toMatchObject({
        points: [
          { time: 0, value: 0 },
          { time: 150, value: 150 },
          { time: 300, value: 300 },
        ],
      });
    });

    it("commits a constant without keys while the track is empty", () => {
      const transforms: ClipTransform[] = [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 10, y: 0 },
        },
      ];

      const result = commitLayoutControlToTransforms({
        clip: createClip(transforms),
        transforms,
        groupId: "scale",
        controlName: "x",
        value: 2,
        playheadTicks: 150,
        pointEpsilonTicks: 1,
      });

      expect(result?.changedOtherTransforms).toBe(false);
      expect(result?.nextTransforms[0]).toBe(transforms[0]);
      expect(result?.nextTransforms[1]).toMatchObject({
        type: "scale",
        parameters: { x: 2 },
      });
      expect(result?.nextTransforms[1].keyframeTimes ?? []).toEqual([]);
    });

    it("does not key the track for non-numeric layout controls", () => {
      const transforms: ClipTransform[] = [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [0],
        },
        {
          id: "scale_1",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1, y: 1, isLinked: true },
        },
      ];

      const result = commitLayoutControlToTransforms({
        clip: createClip(transforms),
        transforms,
        groupId: "scale",
        controlName: "isLinked",
        value: false,
        playheadTicks: 150,
        pointEpsilonTicks: 1,
      });

      expect(result?.changedOtherTransforms).toBe(false);
      expect(result?.nextTransforms[0]).toBe(transforms[0]);
      expect(result?.nextTransforms[1].keyframeTimes ?? []).toEqual([]);
    });
  });
});
