import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AudioTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";

function createTrack(id: string): TimelineTrack {
  return {
    id,
    label: id,
    isVisible: true,
    isLocked: false,
    isMuted: false,
  };
}

function createVideoClip(id: string, trackId: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    assetId: `${id}-asset`,
    trackId,
    start: 0,
    sourceDuration: 240_000,
    timelineDuration: 240_000,
    croppedSourceDuration: 240_000,
    offset: 0,
    transformedDuration: 240_000,
    transformedOffset: 0,
    transformations: [],
  };
}

function createAudioClip(id: string, trackId: string): AudioTimelineClip {
  return {
    id,
    type: "audio",
    name: id,
    assetId: `${id}-asset`,
    trackId,
    start: 0,
    sourceDuration: 240_000,
    timelineDuration: 240_000,
    croppedSourceDuration: 240_000,
    offset: 0,
    transformedDuration: 240_000,
    transformedOffset: 0,
    transformations: [],
  };
}

describe("useTimelineStore addClipsOnNewTracksBelow", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track-top-pad"),
        createTrack("track-source"),
        createTrack("track-lower"),
        createTrack("track-bottom-pad"),
      ],
      clips: [
        createVideoClip("source-clip", "track-source"),
        createVideoClip("lower-clip", "track-lower"),
      ],
    });
    useTimelineStore.setState({ selectedClipIds: [] });
  });

  it("adds multiple clips on fresh tracks directly below the source track", () => {
    let insertedClipIds: string[] = [];

    act(() => {
      insertedClipIds = useTimelineStore
        .getState()
        .addClipsOnNewTracksBelow("track-source", [
          {
            trackLabel: "SAM-Audio Target",
            trackType: "audio",
            createClip: (trackId) => createAudioClip("target-clip", trackId),
          },
          {
            trackLabel: "SAM-Audio Residual",
            trackType: "audio",
            createClip: (trackId) => createAudioClip("residual-clip", trackId),
          },
        ]);
    });

    const state = useTimelineStore.getState();
    const sourceTrackIndex = state.tracks.findIndex(
      (track) => track.id === "track-source",
    );
    const targetClip = state.clips.find((clip) => clip.id === "target-clip");
    const residualClip = state.clips.find((clip) => clip.id === "residual-clip");

    expect(insertedClipIds).toEqual(["target-clip", "residual-clip"]);
    expect(state.selectedClipIds).toEqual(insertedClipIds);
    expect(targetClip?.type).toBe("audio");
    expect(residualClip?.type).toBe("audio");
    expect(state.tracks[sourceTrackIndex + 1].id).toBe(targetClip?.trackId);
    expect(state.tracks[sourceTrackIndex + 2].id).toBe(residualClip?.trackId);
    expect(
      state.tracks.findIndex((track) => track.id === "track-lower"),
    ).toBeGreaterThan(sourceTrackIndex + 2);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });

    const undoneState = useTimelineStore.getState();
    expect(
      undoneState.clips.some(
        (clip) => clip.id === "target-clip" || clip.id === "residual-clip",
      ),
    ).toBe(false);
    expect(undoneState.tracks.map((track) => track.id)).toEqual([
      "track-top-pad",
      "track-source",
      "track-lower",
      "track-bottom-pad",
    ]);
  });
});
