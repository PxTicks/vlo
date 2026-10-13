import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { useLayoutKeyframeTrack } from "../useLayoutKeyframeTrack";

function createClip(transformations: ClipTransform[]): TimelineClip {
  return {
    id: "clip_keyframe_toggle",
    trackId: "track_1",
    type: "video",
    name: "Toggle",
    assetId: "asset_1",
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

function renderLayoutTrack(clip: TimelineClip) {
  const onSetTransforms = vi.fn();
  const { result } = renderHook(() =>
    useLayoutKeyframeTrack({
      clipId: clip.id,
      timelineClip: clip,
      targetTransforms: clip.transformations,
      onSetTransforms,
    }),
  );
  return { result, onSetTransforms };
}

const keyedNext = (onSetTransforms: ReturnType<typeof vi.fn>) =>
  (onSetTransforms.mock.calls[0][0] as ClipTransform[]).map((transform) => [
    transform.type,
    transform.keyframeTimes,
  ]);

describe("useLayoutKeyframeTrack", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
          type: "visual",
        },
      ],
      clips: [],
    });
  });

  it("shows any layout key as active and removes it from every transform", () => {
    const clip = createClip([
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 0 },
        keyframeTimes: [TICKS_PER_SECOND],
      },
      {
        id: "scale_1",
        type: "scale",
        isEnabled: true,
        parameters: { x: 1.5, y: 1.5, isLinked: true },
        keyframeTimes: [TICKS_PER_SECOND],
      },
    ]);
    useTimelineStore.setState({ clips: [clip] });
    playbackClock.setTime(TICKS_PER_SECOND);

    const { result, onSetTransforms } = renderLayoutTrack(clip);
    expect(result.current.active).toBe(true);

    act(() => result.current.toggleKeyframe());

    const next = onSetTransforms.mock.calls[0][0] as ClipTransform[];
    expect(next.map((transform) => transform.keyframeTimes)).toEqual([[], []]);
    // Un-keying keeps the values the clip showed.
    expect(next[0].parameters).toMatchObject({ x: 10, y: 0 });
    expect(next[1].parameters).toMatchObject({ x: 1.5, y: 1.5 });
  });

  it("keys every existing layout transform without creating the absent ones", () => {
    const clip = createClip([
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 0 },
      },
    ]);
    useTimelineStore.setState({ clips: [clip] });
    playbackClock.setTime(2 * TICKS_PER_SECOND);

    const { result, onSetTransforms } = renderLayoutTrack(clip);
    expect(result.current.active).toBe(false);

    act(() => result.current.toggleKeyframe());

    expect(keyedNext(onSetTransforms)).toEqual([
      ["position", [2 * TICKS_PER_SECOND]],
    ]);
    const next = onSetTransforms.mock.calls[0][0] as ClipTransform[];
    expect(next[0].parameters).toMatchObject({ x: 10, y: 0 });
  });

  it("creates a default position to hold the first key on an untransformed clip", () => {
    const clip = createClip([]);
    useTimelineStore.setState({ clips: [clip] });
    playbackClock.setTime(TICKS_PER_SECOND);

    const { result, onSetTransforms } = renderLayoutTrack(clip);
    act(() => result.current.toggleKeyframe());

    expect(keyedNext(onSetTransforms)).toEqual([
      ["position", [TICKS_PER_SECOND]],
    ]);
    const [position] = onSetTransforms.mock.calls[0][0] as ClipTransform[];
    expect(position.parameters).toEqual({ x: 0, y: 0 });
  });

  it("keys scale instead when position follows a path", () => {
    const clip = createClip([
      {
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
      },
    ]);
    useTimelineStore.setState({ clips: [clip] });
    playbackClock.setTime(TICKS_PER_SECOND);

    const { result, onSetTransforms } = renderLayoutTrack(clip);
    act(() => result.current.toggleKeyframe());

    expect(keyedNext(onSetTransforms)).toEqual([
      ["position", undefined],
      ["scale", [TICKS_PER_SECOND]],
    ]);
  });
});
