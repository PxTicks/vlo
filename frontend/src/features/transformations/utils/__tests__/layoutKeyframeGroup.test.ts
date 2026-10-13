import { describe, expect, it } from "vitest";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import {
  addLayoutKeyframe,
  getLayoutKeyframeTimes,
  moveLayoutKeyframe,
  prepareLayoutKeyframeCommit,
  removeLayoutKeyframe,
} from "../layoutKeyframeGroup";

const EPSILON = 1;

const keyedPosition = (): ClipTransform => ({
  id: "position_1",
  type: "position",
  isEnabled: true,
  parameters: {
    x: {
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 100, value: 100 },
      ],
    },
    y: 5,
  },
  keyframeTimes: [0, 100],
});

const staticScale = (): ClipTransform => ({
  id: "scale_1",
  type: "scale",
  isEnabled: true,
  parameters: { x: 1.5, y: 1.5, isLinked: true },
});

const pathPosition = (): ClipTransform => ({
  id: "position_path",
  type: "position",
  isEnabled: true,
  parameters: {
    x: 0,
    y: 0,
    path: {
      type: "path2d",
      curve: "centripetal_catmull_rom",
      controlPoints: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      timing: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
      },
    },
  },
  keyframeTimes: [40],
});

describe("layoutKeyframeGroup", () => {
  it("takes the union of layout key times, ignoring path-driven position", () => {
    expect(
      getLayoutKeyframeTimes(
        [keyedPosition(), { ...staticScale(), keyframeTimes: [50, 100.5] }],
        EPSILON,
      ),
    ).toEqual([0, 50, 100]);
    expect(
      getLayoutKeyframeTimes([pathPosition(), staticScale()], EPSILON),
    ).toEqual([]);
  });

  it("adds a key that holds every channel's current value", () => {
    const next = addLayoutKeyframe([keyedPosition(), staticScale()], 50, EPSILON);

    const [position, scale] = next;
    expect(position.keyframeTimes).toEqual([0, 50, 100]);
    expect(position.parameters.x).toEqual({
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 50, value: 50 },
        { time: 100, value: 100 },
      ],
    });
    // An un-keyed channel joins the whole track, still holding its constant.
    expect(scale.keyframeTimes).toEqual([0, 50, 100]);
    expect(scale.parameters).toEqual({ x: 1.5, y: 1.5, isLinked: true });
  });

  it("leaves path-driven position out of the track", () => {
    const path = pathPosition();
    const next = addLayoutKeyframe([path, staticScale()], 50, EPSILON);
    expect(next[0]).toBe(path);
    expect(next[1].keyframeTimes).toEqual([50]);
  });

  it("removes a key everywhere and freezes channels left without keys", () => {
    const keyed = addLayoutKeyframe([keyedPosition(), staticScale()], 50, EPSILON);

    const withoutMiddle = removeLayoutKeyframe(keyed, 50, EPSILON);
    expect(withoutMiddle.map((transform) => transform.keyframeTimes)).toEqual([
      [0, 100],
      [0, 100],
    ]);

    const singleKey = removeLayoutKeyframe(
      removeLayoutKeyframe(withoutMiddle, 0, EPSILON),
      100,
      EPSILON,
    );
    expect(singleKey.map((transform) => transform.keyframeTimes)).toEqual([[], []]);
    // The last removal keeps the value shown there instead of a default.
    expect(singleKey[0].parameters).toMatchObject({ x: 100, y: 5 });
    expect(singleKey[1].parameters).toMatchObject({ x: 1.5, y: 1.5 });
  });

  it("moves a key in every transform that has it", () => {
    const keyed = addLayoutKeyframe([keyedPosition(), staticScale()], 50, EPSILON);
    const moved = moveLayoutKeyframe(keyed, 50, 70, EPSILON);

    expect(moved.map((transform) => transform.keyframeTimes)).toEqual([
      [0, 70, 100],
      [0, 70, 100],
    ]);
    expect(moved[0].parameters.x).toMatchObject({
      points: [
        { time: 0, value: 0 },
        { time: 70, value: 50 },
        { time: 100, value: 100 },
      ],
    });
  });

  it("keys a commit target into a track that already has keys", () => {
    const prepared = prepareLayoutKeyframeCommit(
      [keyedPosition(), staticScale()],
      "scale",
      undefined,
      EPSILON,
    );
    expect(prepared[1].keyframeTimes).toEqual([0, 100]);

    const created = prepareLayoutKeyframeCommit(
      [keyedPosition()],
      "rotation",
      undefined,
      EPSILON,
    );
    expect(created.map((transform) => transform.type)).toEqual([
      "position",
      "rotation",
    ]);
    expect(created[1]).toMatchObject({
      parameters: { angle: 0 },
      keyframeTimes: [0, 100],
    });
  });

  it("leaves transforms alone while the track has no keys", () => {
    const transforms = [staticScale()];
    expect(
      prepareLayoutKeyframeCommit(transforms, "position", undefined, EPSILON),
    ).toBe(transforms);
  });
});
