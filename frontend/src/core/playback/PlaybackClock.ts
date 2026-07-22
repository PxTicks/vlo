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
// These were previously published on `window` as `__PLAYBACK_CLOCK__` /
// `__PLAYBACK_FRAME_CLOCK__` for console diagnostics, unconditionally and in
// production. That exposed the live `setTime` mutators, so any script on the
// page could drive the playhead. Read-only diagnostics now live behind the
// build-time flag in `app/installE2EDiagnostics.ts`; module scope stays clean.

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
