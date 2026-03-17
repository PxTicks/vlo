import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTimelineStore } from "../useTimelineStore";
import type {
  ClipMask,
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";

const createTrack = (id: string, label: string): TimelineTrack => ({
  id,
  label,
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

const createClip = (
  id: string,
  trackId: string,
  start: number,
  duration: number,
): TimelineClip =>
  ({
    id,
    trackId,
    type: "video",
    name: id,
    start,
    timelineDuration: duration,
    offset: 0,
    croppedSourceDuration: duration,
    transformedOffset: 0,
    sourceDuration: duration,
    transformedDuration: duration,
    transformations: [],
  }) as TimelineClip;

describe("useTimelineStore undo/redo", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [],
    });
  });

  it("round-trips add/move/remove with undo and redo", () => {
    const clip = createClip("clip-1", "track_current", 0, 100);

    act(() => {
      useTimelineStore.getState().addClip(clip);
      useTimelineStore.getState().updateClipPosition(clip.id, 120);
      useTimelineStore.getState().removeClip(clip.id);
    });

    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(useTimelineStore.getState().canUndo).toBe(true);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(1);
    expect(useTimelineStore.getState().clips[0].start).toBe(120);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips[0].start).toBe(0);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(useTimelineStore.getState().canUndo).toBe(false);
    expect(useTimelineStore.getState().canRedo).toBe(true);

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
      expect(useTimelineStore.getState().redo()).toBe(true);
      expect(useTimelineStore.getState().redo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(useTimelineStore.getState().canRedo).toBe(false);
  });

  it("keeps selection/copy buffer outside undo history", () => {
    const clip = createClip("clip-2", "track_current", 0, 100);

    act(() => {
      useTimelineStore.getState().addClip(clip);
      useTimelineStore.getState().selectClip(clip.id);
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      useTimelineStore.getState().updateClipPosition(clip.id, 75);
      useTimelineStore.getState().selectClip(null);
    });

    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
    expect(useTimelineStore.getState().copiedClips.length).toBeGreaterThan(0);
    expect(useTimelineStore.getState().clips[0].start).toBe(75);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });

    expect(useTimelineStore.getState().clips[0].start).toBe(0);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
    expect(useTimelineStore.getState().copiedClips.length).toBeGreaterThan(0);
  });

  it("undoes paste and split in single history steps", () => {
    const baseTracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above", "Track 2"),
      createTrack("track_current", "Track 3"),
      createTrack("track_bottom_pad", "Track 4"),
    ];
    const clip = createClip("source", "track_current", 100, 60);

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: baseTracks,
      clips: [clip],
    });
    useTimelineStore.setState({ selectedClipIds: [clip.id], copiedClips: [] });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    expect(useTimelineStore.getState().clips).toHaveLength(2);
    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(1);

    act(() => {
      useTimelineStore.getState().splitClip("source", 130);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(2);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(1);
  });

  it("preserves parent speed inheritance to masks through undo/redo", () => {
    const clip = createClip("parent", "track_current", 0, 120);
    const mask: ClipMask = {
      id: "mask-1",
      isEnabled: true,
      type: "rectangle",
      mode: "apply",
      inverted: false,
      parameters: {
        baseWidth: 100,
        baseHeight: 100,
      },
      transformations: [],
    };
    const speedTransform: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };

    act(() => {
      useTimelineStore.getState().addClip(clip);
      useTimelineStore.getState().addClipMask(clip.id, mask);
      useTimelineStore.getState().addClipTransform(clip.id, speedTransform);
    });

    const maskClipAfterAdd = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.type === "mask");
    expect(maskClipAfterAdd).toBeDefined();
    expect(maskClipAfterAdd?.transformations.some((t) => t.type === "speed")).toBe(
      true,
    );

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });

    const maskClipAfterUndo = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.type === "mask");
    expect(maskClipAfterUndo).toBeDefined();
    expect(maskClipAfterUndo?.transformations.some((t) => t.type === "speed")).toBe(
      false,
    );

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
    });

    const maskClipAfterRedo = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.type === "mask");
    expect(maskClipAfterRedo).toBeDefined();
    expect(maskClipAfterRedo?.transformations.some((t) => t.type === "speed")).toBe(
      true,
    );
  });
});
