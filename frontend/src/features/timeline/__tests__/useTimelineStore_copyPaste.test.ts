import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTimelineStore } from "../useTimelineStore";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";

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

describe("useTimelineStore copy/paste (single and multiple clips)", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: [],
      clips: [],
      selectedClipIds: [],
      copiedClips: [],
    });
  });

  it("pastes the copied clip on the track directly above when there is no collision", () => {
    const tracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above", "Track 2"),
      createTrack("track_current", "Track 3"),
      createTrack("track_bottom_pad", "Track 4"),
    ];
    const sourceClip = createClip("source", "track_current", 100, 50);

    useTimelineStore.setState({
      tracks,
      clips: [sourceClip],
      selectedClipIds: [sourceClip.id],
      copiedClips: [],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const state = useTimelineStore.getState();
    const pastedClip = state.clips.find((c) => c.id !== sourceClip.id);

    expect(pastedClip).toBeDefined();
    expect(pastedClip?.trackId).toBe("track_above");
    expect(pastedClip?.start).toBe(sourceClip.start);
    expect(pastedClip?.timelineDuration).toBe(sourceClip.timelineDuration);
    expect(state.tracks.map((t) => t.id)).toEqual(tracks.map((t) => t.id));
  });

  it("inserts a track between current and above when the above track collides", () => {
    const tracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above", "Track 2"),
      createTrack("track_current", "Track 3"),
      createTrack("track_bottom_pad", "Track 4"),
    ];
    const sourceClip = createClip("source", "track_current", 100, 50);
    const obstacleClip = createClip("obstacle", "track_above", 100, 50);

    useTimelineStore.setState({
      tracks,
      clips: [sourceClip, obstacleClip],
      selectedClipIds: [sourceClip.id],
      copiedClips: [],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const state = useTimelineStore.getState();
    const pastedClip = state.clips.find(
      (c) => c.id !== sourceClip.id && c.id !== obstacleClip.id,
    );

    expect(pastedClip).toBeDefined();
    expect(pastedClip?.start).toBe(sourceClip.start);
    expect(pastedClip?.timelineDuration).toBe(sourceClip.timelineDuration);
    expect(tracks.map((t) => t.id)).not.toContain(pastedClip?.trackId ?? "");

    const aboveIndex = state.tracks.findIndex((t) => t.id === "track_above");
    const currentIndex = state.tracks.findIndex(
      (t) => t.id === "track_current",
    );
    const pastedTrackIndex = state.tracks.findIndex(
      (t) => t.id === pastedClip?.trackId,
    );

    expect(pastedTrackIndex).toBe(aboveIndex + 1);
    expect(pastedTrackIndex).toBe(currentIndex - 1);
  });

  it("pastes multiple selected clips from one track onto the same above track when none collide", () => {
    const tracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above", "Track 2"),
      createTrack("track_current", "Track 3"),
      createTrack("track_bottom_pad", "Track 4"),
    ];

    const clipA = createClip("source_a", "track_current", 100, 40);
    const clipB = createClip("source_b", "track_current", 220, 60);

    useTimelineStore.setState({
      tracks,
      clips: [clipA, clipB],
      selectedClipIds: [clipA.id, clipB.id],
      copiedClips: [],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const state = useTimelineStore.getState();
    const sourceIds = new Set([clipA.id, clipB.id]);
    const pastedClips = state.clips.filter((clip) => !sourceIds.has(clip.id));

    expect(pastedClips).toHaveLength(2);
    expect(pastedClips.every((clip) => clip.trackId === "track_above")).toBe(
      true,
    );

    const pastedByName = new Map(pastedClips.map((clip) => [clip.name, clip]));
    expect(pastedByName.get(clipA.name)?.start).toBe(clipA.start);
    expect(pastedByName.get(clipA.name)?.timelineDuration).toBe(
      clipA.timelineDuration,
    );
    expect(pastedByName.get(clipB.name)?.start).toBe(clipB.start);
    expect(pastedByName.get(clipB.name)?.timelineDuration).toBe(
      clipB.timelineDuration,
    );
  });

  it("moves all pasted children from a source track to one inserted track when any selected clip collides above", () => {
    const tracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above", "Track 2"),
      createTrack("track_current", "Track 3"),
      createTrack("track_bottom_pad", "Track 4"),
    ];

    const clipA = createClip("source_a", "track_current", 100, 40);
    const clipB = createClip("source_b", "track_current", 220, 60);
    const obstacle = createClip("obstacle", "track_above", 95, 50); // Collides with clipA only

    useTimelineStore.setState({
      tracks,
      clips: [clipA, clipB, obstacle],
      selectedClipIds: [clipA.id, clipB.id],
      copiedClips: [],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const state = useTimelineStore.getState();
    const sourceIds = new Set([clipA.id, clipB.id, obstacle.id]);
    const pastedClips = state.clips.filter((clip) => !sourceIds.has(clip.id));

    expect(pastedClips).toHaveLength(2);

    const pastedTrackIds = new Set(pastedClips.map((clip) => clip.trackId));
    expect(pastedTrackIds.size).toBe(1);

    const insertedTrackId = pastedClips[0].trackId;
    expect(tracks.map((track) => track.id)).not.toContain(insertedTrackId);

    const aboveIndex = state.tracks.findIndex(
      (track) => track.id === "track_above",
    );
    const currentIndex = state.tracks.findIndex(
      (track) => track.id === "track_current",
    );
    const insertedTrackIndex = state.tracks.findIndex(
      (track) => track.id === insertedTrackId,
    );

    expect(insertedTrackIndex).toBe(aboveIndex + 1);
    expect(insertedTrackIndex).toBe(currentIndex - 1);
  });

  it("applies collision fallback per source track group when copying clips from different tracks", () => {
    const tracks = [
      createTrack("track_top_pad", "Track 1"),
      createTrack("track_above_a", "Track 2"),
      createTrack("track_current_a", "Track 3"),
      createTrack("track_above_b", "Track 4"),
      createTrack("track_current_b", "Track 5"),
      createTrack("track_bottom_pad", "Track 6"),
    ];

    const clipA = createClip("source_a", "track_current_a", 100, 40);
    const clipB1 = createClip("source_b1", "track_current_b", 120, 30);
    const clipB2 = createClip("source_b2", "track_current_b", 220, 45);
    const obstacleOnAboveB = createClip("obstacle_b", "track_above_b", 110, 40);

    useTimelineStore.setState({
      tracks,
      clips: [clipA, clipB1, clipB2, obstacleOnAboveB],
      selectedClipIds: [clipA.id, clipB1.id, clipB2.id],
      copiedClips: [],
    });

    act(() => {
      expect(useTimelineStore.getState().copySelectedClip()).toBe(true);
      expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    });

    const state = useTimelineStore.getState();
    const sourceIds = new Set([
      clipA.id,
      clipB1.id,
      clipB2.id,
      obstacleOnAboveB.id,
    ]);
    const pastedClips = state.clips.filter((clip) => !sourceIds.has(clip.id));
    expect(pastedClips).toHaveLength(3);

    const pastedA = pastedClips.find((clip) => clip.name === clipA.name);
    const pastedB1 = pastedClips.find((clip) => clip.name === clipB1.name);
    const pastedB2 = pastedClips.find((clip) => clip.name === clipB2.name);

    expect(pastedA?.trackId).toBe("track_above_a");
    expect(pastedB1).toBeDefined();
    expect(pastedB2).toBeDefined();
    expect(pastedB1?.trackId).toBe(pastedB2?.trackId);
    expect(pastedB1?.trackId).not.toBe("track_above_b");
    expect(tracks.map((track) => track.id)).not.toContain(
      pastedB1?.trackId ?? "",
    );
  });
});
