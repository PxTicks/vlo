import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { useProjectStore } from "../../../project/useProjectStore";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { TEXT_DEFAULT_DURATION_SECONDS } from "../../constants";
import { createTextClip } from "../createTextClip";
import { insertTextClipAtPlayhead } from "../insertTextClipAtPlayhead";

describe("createTextClip", () => {
  it("builds a default-length text clip named after its content", () => {
    const clip = createTextClip({ content: "  Opening title  " });
    const duration = TEXT_DEFAULT_DURATION_SECONDS * TICKS_PER_SECOND;

    expect(clip.id).toMatch(/^clip_/);
    expect(clip).toMatchObject({
      type: "text",
      name: "Opening title",
      sourceDuration: null,
      timelineDuration: duration,
      croppedSourceDuration: duration,
      transformedDuration: duration,
      offset: 0,
      transformedOffset: 0,
      transformations: [],
    });
    expect(clip.textData.content).toBe("  Opening title  ");
    expect(createTextClip().id).not.toBe(clip.id);
  });
});

describe("insertTextClipAtPlayhead", () => {
  beforeEach(() => {
    useProjectStore.setState((state) => ({
      ...state,
      config: { ...state.config, fps: 30 },
    }));
    useTimelineStore.setState({
      tracks: [],
      clips: [],
      transitions: [],
      selectedClipIds: [],
    });
  });

  afterEach(() => {
    playbackClock.setTime(0);
  });

  it("inserts at the frame-snapped playhead and selects the new clip", () => {
    // 1.01 s sits between frames 30 and 31; it snaps to the nearer one.
    playbackClock.setTime(Math.round(1.01 * TICKS_PER_SECOND));

    const clipId = insertTextClipAtPlayhead({ content: "Hello" });

    const state = useTimelineStore.getState();
    const clip = state.clips.find((candidate) => candidate.id === clipId);
    expect(clip).toMatchObject({ type: "text", name: "Hello", start: TICKS_PER_SECOND });
    expect(state.tracks.find((track) => track.id === clip?.trackId)?.type).toBe(
      "visual",
    );
    expect(state.selectedClipIds).toEqual([clipId]);
  });

  it("stacks a second insertion above an occupied track", () => {
    playbackClock.setTime(0);
    const firstId = insertTextClipAtPlayhead();
    const secondId = insertTextClipAtPlayhead();

    const { clips, tracks } = useTimelineStore.getState();
    const trackIndex = (clipId: string | null) =>
      tracks.findIndex(
        (track) =>
          track.id === clips.find((clip) => clip.id === clipId)?.trackId,
      );
    expect(trackIndex(secondId)).toBeGreaterThanOrEqual(0);
    expect(trackIndex(secondId)).toBeLessThan(trackIndex(firstId));
  });
});
