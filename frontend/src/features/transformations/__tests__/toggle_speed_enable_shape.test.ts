import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransformationController } from "../hooks/useTransformationController";
import { useTimelineStore, TICKS_PER_SECOND } from "../../timeline";

describe("useTransformationController speed toggle", () => {
  const clipId = "clip-speed";
  const speedId = "speed-1";
  const track = {
    id: "track-1",
    label: "Track 1",
    isVisible: true,
    isLocked: false,
    isMuted: false,
    type: "visual" as const,
  };

  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [
        {
          id: clipId,
          trackId: track.id,
          start: 0,
          timelineDuration: 5 * TICKS_PER_SECOND,
          offset: 0,
          type: "video",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Speed Clip",
          assetId: `asset_${clipId}`,
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 5 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [
            {
              id: speedId,
              type: "speed",
              isEnabled: true,
              parameters: { factor: 2 },
            },
          ],
        },
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [clipId] });
  });

  it("disables speed and recomputes clip shape", () => {
    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleSetTransformEnabled(speedId, false);
    });

    const clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);

    const speedTransform = clip?.transformations.find((t) => t.id === speedId);
    expect(speedTransform?.isEnabled).toBe(false);
    expect(clip?.timelineDuration).toBeGreaterThan(5 * TICKS_PER_SECOND);
    expect(clip?.transformedDuration).toBeGreaterThan(5 * TICKS_PER_SECOND);
  });

  it("undoes a speed factor commit in a single history step", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [
        {
          id: clipId,
          trackId: track.id,
          start: 0,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 0,
          type: "video",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Undo Speed Clip",
          assetId: `asset_${clipId}`,
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 10 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
        },
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [clipId] });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit("speed", "factor", 2);
    });

    let clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);
    expect(clip?.timelineDuration).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.transformations.some((transform) => transform.type === "speed")).toBe(
      true,
    );

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });

    clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);
    expect(clip?.timelineDuration).toBe(10 * TICKS_PER_SECOND);
    expect(clip?.transformedDuration).toBe(10 * TICKS_PER_SECOND);
    expect(clip?.transformations.some((transform) => transform.type === "speed")).toBe(
      false,
    );

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
    });

    clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);
    expect(clip?.timelineDuration).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.transformations.some((transform) => transform.type === "speed")).toBe(
      true,
    );
  });

  it("keeps the trimmed source window anchored when adding speed", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [
        {
          id: clipId,
          trackId: track.id,
          start: 5 * TICKS_PER_SECOND,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 5 * TICKS_PER_SECOND,
          type: "video",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Trimmed Speed Clip",
          assetId: `asset_${clipId}`,
          sourceDuration: 15 * TICKS_PER_SECOND,
          transformedDuration: 15 * TICKS_PER_SECOND,
          transformedOffset: 5 * TICKS_PER_SECOND,
          transformations: [],
        },
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [clipId] });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit("speed", "factor", 2);
    });

    const clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);

    expect(clip?.timelineDuration).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.transformedOffset).toBe(2.5 * TICKS_PER_SECOND);
    expect(clip?.transformedDuration).toBe(7.5 * TICKS_PER_SECOND);
    expect(clip?.offset).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.croppedSourceDuration).toBe(10 * TICKS_PER_SECOND);
  });

  it("recomputes an adjustment clip footprint when adding speed", () => {
    const adjustmentTrack = {
      id: "track-adj",
      label: "Adjustment",
      isVisible: true,
      isLocked: false,
      isMuted: false,
      type: "adjustment" as const,
    };

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [adjustmentTrack],
      clips: [
        {
          id: clipId,
          trackId: adjustmentTrack.id,
          start: 0,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 0,
          type: "adjustment",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Adjustment Speed Clip",
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 10 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
          depth: 1,
        },
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [clipId] });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit("speed", "factor", 2);
    });

    const clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);

    expect(clip?.timelineDuration).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.transformedDuration).toBe(5 * TICKS_PER_SECOND);
    expect(clip?.transformations.some((transform) => transform.type === "speed")).toBe(
      true,
    );
  });

  it("rejects an adjustment speed change when the new footprint would collide", () => {
    const adjustmentTrack = {
      id: "track-adj",
      label: "Adjustment",
      isVisible: true,
      isLocked: false,
      isMuted: false,
      type: "adjustment" as const,
    };

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [adjustmentTrack],
      clips: [
        {
          id: clipId,
          trackId: adjustmentTrack.id,
          start: 0,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 0,
          type: "adjustment",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Adjustment Speed Clip",
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 10 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
          depth: 1,
        },
        {
          id: "clip-neighbor",
          trackId: adjustmentTrack.id,
          start: 10 * TICKS_PER_SECOND,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 0,
          type: "adjustment",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Neighbor Adjustment",
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 10 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
          depth: 1,
        },
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [clipId] });

    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleCommit("speed", "factor", 0.5);
    });

    const clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);

    expect(clip?.timelineDuration).toBe(10 * TICKS_PER_SECOND);
    expect(clip?.transformations.some((transform) => transform.type === "speed")).toBe(
      false,
    );
  });
});
