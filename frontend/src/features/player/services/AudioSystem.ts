import { TICKS_PER_SECOND } from "../../timeline";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private startTime: number = 0; // The AudioContext time when playback started
  private playbackStartTicks: number = 0; // The timeline tick when playback started

  constructor() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      this.ctx = new AudioContextClass({ sampleRate: 48000 });
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
    }
  }

  getContext() {
    return this.ctx;
  }

  getMasterGain() {
    return this.masterGain;
  }

  async resume() {
    if (this.ctx?.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn("AudioContext resume failed", err);
      }
    }
  }

  setVolume(volume: number) {
    if (this.masterGain) {
      this.masterGain.gain.value = volume;
    }
  }

  /**
   * call this when playback starts (Play button pressed)
   * @param currentTicks The current position of the playhead in ticks
   */
  notifyPlay(currentTicks: number) {
    if (!this.ctx) return;
    this.startTime = this.ctx.currentTime;
    this.playbackStartTicks = currentTicks;
  }

  /**
   * Returns the estimated current playback time in Ticks.
   * This is used to sync the UI and Video to the Audio clock.
   */
  getCurrentPlaybackTicks(): number {
    if (!this.ctx) return this.playbackStartTicks;

    // Elapsed time in seconds since play started
    const elapsed = this.ctx.currentTime - this.startTime;

    // Convert to ticks and add to start
    return this.playbackStartTicks + elapsed * TICKS_PER_SECOND;
  }

  /**
   * Converts a Timeline Tick to the corresponding AudioContext time.
   */
  ticksToContextTime(ticks: number): number {
    if (!this.ctx) return 0;
    const ticksElapsed = ticks - this.playbackStartTicks;
    const secondsElapsed = ticksElapsed / TICKS_PER_SECOND;
    return this.startTime + secondsElapsed;
  }

  getStartTime() {
    return this.startTime;
  }
}

export const audioSystem = new AudioSystem();
