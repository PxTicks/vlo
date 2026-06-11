import { getTicksPerFrame } from "../time/ticksPerFrame";

type TimeListener = (time: number) => void;

export class PlaybackClock {
  private currentTime: number = 0;
  private listeners = new Set<TimeListener>();

  get time() {
    return this.currentTime;
  }

  /**
   * Sets the current time in ticks.
   * Notifies listeners only if time has changed.
   */
  setTime(time: number) {
    const newTime = Math.max(0, time);
    if (this.currentTime === newTime) return;

    this.currentTime = newTime;
    this.notify();
  }

  subscribe(listener: TimeListener) {
    this.listeners.add(listener);
    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.currentTime);
    }
  }
}

export const playbackClock = new PlaybackClock();
export const playbackFrameClock = new PlaybackClock();
// DEBUG: expose for console diagnostics
const _w = window as unknown as Record<string, unknown>;
_w.__PLAYBACK_CLOCK__ = playbackClock;
_w.__PLAYBACK_FRAME_CLOCK__ = playbackFrameClock;

export function alignPlaybackTickToFrame(
  time: number,
  fps: number,
): number {
  const safeTime = Math.max(0, time);
  const ticksPerFrame = getTicksPerFrame(fps);
  const frameEpsilon = ticksPerFrame / 1_000_000;
  const frameIndex = Math.floor((safeTime + frameEpsilon) / ticksPerFrame);
  return frameIndex * ticksPerFrame;
}
