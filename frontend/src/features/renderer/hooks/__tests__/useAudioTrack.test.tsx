import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";

const mocks = vi.hoisted(() => ({
  playerState: { isPlaying: false },
  clips: [] as TimelineClip[],
  getInput: vi.fn(),
  context: {
    currentTime: 5,
  } as unknown as AudioContext | null,
  master: { id: "master" } as unknown as GainNode | null,
  startTime: 2,
  resume: vi.fn(async () => undefined),
  getCurrentPlaybackTicks: vi.fn(() => 96000),
  rendererInstances: [] as Array<{
    getNextScheduleTime: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    process: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../../player/usePlayerStore", () => {
  const usePlayerStore = (
    selector: (state: typeof mocks.playerState) => unknown,
  ) => selector(mocks.playerState);
  usePlayerStore.getState = () => mocks.playerState;
  return { usePlayerStore };
});

vi.mock("../../../timeline/api", () => ({
  useTimelineClipsForTrack: () => mocks.clips,
}));

vi.mock("../../../userAssets", () => ({
  useAssetStore: (
    selector: (state: { getInput: typeof mocks.getInput }) => unknown,
  ) => selector({ getInput: mocks.getInput }),
}));

vi.mock("../../../player/services/AudioSystem", () => ({
  audioSystem: {
    resume: mocks.resume,
    getContext: () => mocks.context,
    getMasterGain: () => mocks.master,
    getStartTime: () => mocks.startTime,
    getCurrentPlaybackTicks: mocks.getCurrentPlaybackTicks,
  },
}));

vi.mock("../../services/TrackAudioRenderer", () => ({
  TrackAudioRenderer: vi.fn(function () {
    const instance = {
      getNextScheduleTime: vi.fn(() => mocks.rendererInstances.length),
      reset: vi.fn(),
      process: vi.fn(async () => undefined),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    mocks.rendererInstances.push(instance);
    return instance;
  }),
}));

import { TrackAudioRenderer } from "../../services/TrackAudioRenderer";
import { useAudioTrack } from "../useAudioTrack";

function clip(id: string, start: number): TimelineClip {
  return {
    id,
    type: "audio",
    trackId: "track-1",
    start,
    timelineDuration: 100,
  } as TimelineClip;
}

describe("useAudioTrack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.playerState.isPlaying = false;
    mocks.clips = [clip("later", 100), clip("first", 0)];
    mocks.context = { currentTime: 5 } as AudioContext;
    mocks.master = { id: "master" } as unknown as GainNode;
    mocks.startTime = 2;
    mocks.rendererInstances = [];
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("creates and disposes a renderer for the track", () => {
    const resolver = { id: "resolver" };
    const { unmount } = renderHook(() =>
      useAudioTrack("track-1", resolver as never),
    );

    expect(TrackAudioRenderer).toHaveBeenCalledWith("track-1", resolver);
    const renderer = mocks.rendererInstances[0];
    unmount();
    expect(renderer.dispose).toHaveBeenCalled();
  });

  it("resumes, resets, and schedules sorted clips while playing", async () => {
    mocks.playerState.isPlaying = true;
    const { unmount } = renderHook(() => useAudioTrack("track-1"));
    const renderer = mocks.rendererInstances[0];

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.resume).toHaveBeenCalled();
    expect(renderer.reset).toHaveBeenCalledWith(5);
    expect(renderer.process).toHaveBeenCalledWith(
      mocks.context,
      mocks.master,
      [expect.objectContaining({ id: "first" }), expect.objectContaining({ id: "later" })],
      mocks.getInput,
      {
        baseContextTime: 5,
        baseTicks: 96000,
      },
      { lookahead: 2 },
    );

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(renderer.process.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  it("resets when the shared playback start changes", async () => {
    mocks.playerState.isPlaying = true;
    const { unmount } = renderHook(() => useAudioTrack("track-1"));
    const renderer = mocks.rendererInstances[0];
    await act(async () => {
      await Promise.resolve();
    });
    renderer.reset.mockClear();
    mocks.startTime = 3;

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(renderer.reset).toHaveBeenCalledWith(5);
    unmount();
  });

  it("warns when a track scheduler fails and continues ticking", async () => {
    mocks.playerState.isPlaying = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useAudioTrack("track-1"));
    const renderer = mocks.rendererInstances[0];
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    renderer.process.mockRejectedValueOnce(new Error("schedule failed"));

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[Audio] Track scheduling failed",
      expect.any(Error),
    );
    unmount();
  });

  it("stops the renderer while paused and does not schedule without audio nodes", async () => {
    mocks.context = null;
    mocks.master = null;
    const { unmount } = renderHook(() => useAudioTrack("track-1"));
    const renderer = mocks.rendererInstances[0];
    expect(renderer.stop).toHaveBeenCalled();
    expect(renderer.process).not.toHaveBeenCalled();
    unmount();
  });

  it("shares one scheduler and prioritizes the earliest renderer", async () => {
    mocks.playerState.isPlaying = true;
    const first = renderHook(() => useAudioTrack("track-1"));
    const second = renderHook(() => useAudioTrack("track-2"));
    const [rendererOne, rendererTwo] = mocks.rendererInstances;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rendererOne.getNextScheduleTime.mockReturnValue(10);
    rendererTwo.getNextScheduleTime.mockReturnValue(1);
    rendererOne.process.mockClear();
    rendererTwo.process.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });
    const oneOrder = rendererOne.process.mock.invocationCallOrder[0];
    const twoOrder = rendererTwo.process.mock.invocationCallOrder[0];
    expect(twoOrder).toBeLessThan(oneOrder);
    first.unmount();
    second.unmount();
  });
});
