import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND, useTimelineStore } from "../../timeline";
import { useTransformationController } from "../hooks/useTransformationController";

const clipId = "clip-spline-sync";
const transformId = "transform-position";

function createClip(transformations: TimelineClip["transformations"]): TimelineClip {
  return {
    id: clipId,
    trackId: "track-1",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    type: "video",
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    name: "Spline Sync Clip",
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    transformations,
  };
}

function getPositionTransform() {
  const clip = useTimelineStore.getState().clips.find((c) => c.id === clipId);
  const transform = clip?.transformations.find((t) => t.id === transformId);
  expect(transform).toBeDefined();
  return transform!;
}

describe("useTransformationController spline/keyframe sync", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      clips: [],
      selectedClipIds: [],
    });
  });

  it("adds spline endpoints to keyframeTimes on scalar-to-spline commit", () => {
    useTimelineStore.setState({
      clips: [
        createClip([
          {
            id: transformId,
            type: "position",
            isEnabled: true,
            parameters: { x: 0, y: 0 },
          },
        ]),
      ],
      selectedClipIds: [clipId],
    });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit(
        "position",
        "x",
        {
          type: "spline",
          points: [
            { time: 120, value: 0 },
            { time: 880, value: 10 },
          ],
        },
        transformId,
      );
    });

    const updated = getPositionTransform();
    expect(updated.keyframeTimes).toEqual([120, 880]);
  });

  it("reconciles missing spline endpoints even when point times are unchanged", () => {
    useTimelineStore.setState({
      clips: [
        createClip([
          {
            id: transformId,
            type: "position",
            isEnabled: true,
            parameters: {
              x: {
                type: "spline",
                points: [
                  { time: 120, value: 0 },
                  { time: 880, value: 10 },
                ],
              },
              y: 0,
            },
            keyframeTimes: [120],
          },
        ]),
      ],
      selectedClipIds: [clipId],
    });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit(
        "position",
        "x",
        {
          type: "spline",
          points: [
            { time: 120, value: 5 },
            { time: 880, value: 15 },
          ],
        },
        transformId,
      );
    });

    const updated = getPositionTransform();
    expect(updated.keyframeTimes).toEqual([120, 880]);
  });

  it("adds keyframe time for added spline points without fan-out to sibling controls", () => {
    useTimelineStore.setState({
      clips: [
        createClip([
          {
            id: transformId,
            type: "position",
            isEnabled: true,
            parameters: {
              x: {
                type: "spline",
                points: [
                  { time: 120, value: 0 },
                  { time: 880, value: 10 },
                ],
              },
              y: {
                type: "spline",
                points: [
                  { time: 120, value: 0 },
                  { time: 880, value: 20 },
                ],
              },
            },
            keyframeTimes: [120, 880],
          },
        ]),
      ],
      selectedClipIds: [clipId],
    });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit(
        "position",
        "x",
        {
          type: "spline",
          points: [
            { time: 120, value: 0 },
            { time: 500, value: 5 },
            { time: 880, value: 10 },
          ],
        },
        transformId,
      );
    });

    const updated = getPositionTransform();
    expect(updated.keyframeTimes).toEqual([120, 500, 880]);

    const yParam = updated.parameters.y as {
      type: "spline";
      points: Array<{ time: number; value: number }>;
    };
    expect(yParam.points.map((p) => p.time)).toEqual([120, 880]);
  });
});
