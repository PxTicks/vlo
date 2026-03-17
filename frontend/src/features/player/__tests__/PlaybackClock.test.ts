import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  alignPlaybackTickToFrame,
  playbackClock,
  playbackFrameClock,
} from "../services/PlaybackClock";
import { TICKS_PER_SECOND } from "../../timeline";

describe("PlaybackClock", () => {
  beforeEach(() => {
    playbackClock.setTime(0);
    playbackFrameClock.setTime(0);
  });

  it("should initialize with time 0", () => {
    expect(playbackClock.time).toBe(0);
  });

  it("should update time when setTime is called", () => {
    playbackClock.setTime(100);
    expect(playbackClock.time).toBe(100);
  });

  it("should not allow negative time", () => {
    playbackClock.setTime(-50);
    expect(playbackClock.time).toBe(0);
  });

  it("should notify listeners when time changes", () => {
    const listener = vi.fn();
    playbackClock.subscribe(listener);

    playbackClock.setTime(50);
    expect(listener).toHaveBeenCalledWith(50);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should not notify listeners if time does not change", () => {
    playbackClock.setTime(200);
    const listener = vi.fn();
    playbackClock.subscribe(listener);

    playbackClock.setTime(200);
    expect(listener).not.toHaveBeenCalled();
  });

  it("should unsubscribe correctly", () => {
    const listener = vi.fn();
    const unsubscribe = playbackClock.subscribe(listener);

    playbackClock.setTime(300);
    expect(listener).toHaveBeenCalledWith(300);

    unsubscribe();
    playbackClock.setTime(400);
    expect(listener).toHaveBeenCalledTimes(1); // Still call count from previous setTime
  });

  it("aligns live playback to the current frame boundary", () => {
    const fps = 30;
    const halfFrame = TICKS_PER_SECOND / fps / 2;
    playbackFrameClock.setTime(
      alignPlaybackTickToFrame(TICKS_PER_SECOND / fps + halfFrame, fps),
    );

    expect(playbackFrameClock.time).toBeCloseTo(TICKS_PER_SECOND / fps);
  });
});
