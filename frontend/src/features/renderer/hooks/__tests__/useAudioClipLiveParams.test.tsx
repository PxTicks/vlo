import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { AdjustmentEffectResolver } from "../../services/AdjustmentEffectResolver";

const mocks = vi.hoisted(() => ({
  clips: [] as TimelineClip[],
}));

vi.mock("../../../timeline/api", () => ({
  useTimelineClipsForTrack: () => mocks.clips,
}));

import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { liveParamStore } from "../../../../core/liveParams/liveParamStore";
import { useAudioClipLiveParams } from "../useAudioClipLiveParams";

const gainSpline = {
  type: "spline",
  points: [
    { time: 0, value: 0 },
    { time: 1000, value: 1 },
  ],
};

function clipWithGain(
  id: string,
  type: TimelineClip["type"],
  start: number,
): TimelineClip {
  return {
    id,
    type,
    trackId: "track-1",
    start,
    timelineDuration: 1000,
    offset: 0,
    transformedOffset: 0,
    transformations: [
      {
        id: `${id}-volume`,
        type: "volume",
        isEnabled: true,
        parameters: { gain: gainSpline },
      },
    ],
  } as unknown as TimelineClip;
}

/**
 * A resolver whose lookup places the clip at a caller-controlled effective
 * tick, standing in for a presentation lookup that retiming edits rebuild.
 */
function fakeResolver(clipId: string) {
  const listeners = new Set<() => void>();
  const state = { offset: 0 };
  const resolver = {
    getPresentationLookup: () => ({
      findActiveClipAt: (_trackId: string, tick: number) =>
        tick >= 2000 && tick < 3000
          ? { clipId, effectiveTick: tick + state.offset }
          : null,
      getPresentation: () => ({}),
    }),
    subscribeToSource: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    resolver: resolver as unknown as AdjustmentEffectResolver,
    retime(offset: number) {
      state.offset = offset;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

describe("useAudioClipLiveParams", () => {
  const unsubscribes: Array<() => void> = [];

  function track(transformId: string): number[] {
    const values: number[] = [];
    unsubscribes.push(
      liveParamStore.subscribe(transformId, "gain", (value) =>
        values.push(value),
      ),
    );
    return values;
  }

  beforeEach(() => {
    playbackClock.setTime(0);
  });

  afterEach(() => {
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
  });

  it("publishes a keyframed gain at the playhead on mount and on every move", () => {
    mocks.clips = [clipWithGain("audio-a", "audio", 2000)];
    const values = track("audio-a-volume");
    playbackClock.setTime(2250);

    const { unmount } = renderHook(() => useAudioClipLiveParams("track-1"));
    expect(values.at(-1)).toBeCloseTo(0.25, 3);

    act(() => playbackClock.setTime(2750));
    expect(values.at(-1)).toBeCloseTo(0.75, 3);

    unmount();
    const count = values.length;
    playbackClock.setTime(2500);
    expect(values).toHaveLength(count);
  });

  it("publishes nothing when no clip is under the playhead", () => {
    mocks.clips = [clipWithGain("audio-b", "audio", 2000)];
    const values = track("audio-b-volume");
    playbackClock.setTime(500);

    renderHook(() => useAudioClipLiveParams("track-1"));

    expect(values).toEqual([]);
  });

  it("leaves visual clips to their render pass", () => {
    mocks.clips = [clipWithGain("video-a", "video", 0)];
    const values = track("video-a-volume");
    playbackClock.setTime(500);

    renderHook(() => useAudioClipLiveParams("track-1"));

    expect(values).toEqual([]);
  });

  it("republishes from the rebuilt lookup when the timing source changes", () => {
    mocks.clips = [clipWithGain("audio-c", "audio", 2000)];
    const values = track("audio-c-volume");
    const fake = fakeResolver("audio-c");
    playbackClock.setTime(2250);

    const { unmount } = renderHook(() =>
      useAudioClipLiveParams("track-1", fake.resolver),
    );
    expect(values.at(-1)).toBeCloseTo(0.25, 3);

    // A paused retime: the playhead stays put but the clip now presents
    // 500 ticks further into its source.
    act(() => fake.retime(500));
    expect(values.at(-1)).toBeCloseTo(0.75, 3);

    unmount();
    expect(fake.listenerCount()).toBe(0);
  });
});
