import { playbackClock, playbackFrameClock } from "../core/playback/PlaybackClock";
import { audioSystem } from "../features/player/services/AudioSystem";
import { usePlayerStore } from "../features/player/usePlayerStore";

/**
 * Read-only diagnostics bridge for the browser-media E2E lane (plan §4.2, §4.6).
 *
 * The Phase 4 canary must compare where video actually is against where audio
 * actually is, at the same project ticks, using the real decoders. Both
 * quantities already exist as public accessors — `playbackFrameClock` is the
 * presentation frame live video follows, and `AudioSystem.getCurrentPlaybackTicks`
 * derives position from the real `AudioContext` clock. They are module
 * singletons, so a Playwright page cannot reach them; this bridge is the whole
 * of the gap.
 *
 * It measures nothing and mutates nothing: no new timing logic lives here, so
 * the canary asserts against the same values the player itself uses rather than
 * against a test-only reimplementation that could agree while the app is wrong.
 *
 * Excluded from production builds. The flag is build-time, so the branch is
 * dead-code eliminated when it is unset.
 */

export interface E2EPlaybackDiagnostics {
  /**
   * Whether transport is running.
   *
   * Load-bearing for any A/V comparison. `audioTicks` is anchored by
   * `AudioSystem.notifyPlay`, which only fires on play; before the first play
   * it degenerates to raw AudioContext elapsed time and will report a large
   * offset against a stationary playhead. Comparing the two clocks is only
   * meaningful while this is true.
   */
  isPlaying: boolean;
  /** Playhead position in project ticks. */
  playheadTicks: number;
  /** Presentation frame live video follows, in project ticks. */
  presentationFrameTicks: number;
  /** Audio position in project ticks, derived from the real AudioContext clock. */
  audioTicks: number;
  /**
   * AudioContext time at which `notifyPlay` last anchored the audio clock.
   *
   * `isPlaying` flips before the playback effect calls `notifyPlay`, so there
   * is a window where transport reports running but the audio clock is still
   * anchored to the previous play. A test can record this value before pressing
   * Play and wait for it to change, rather than inferring the anchor from
   * elapsed wall time.
   */
  audioAnchorTime: number;
  /** Raw AudioContext clock, seconds. Null when no context exists. */
  audioContextTime: number | null;
  /** AudioContext state — 'running' is required for audioTicks to advance. */
  audioContextState: AudioContextState | null;
  audioSampleRate: number | null;
}

declare global {
  interface Window {
    __vloE2E?: {
      getPlaybackDiagnostics: () => E2EPlaybackDiagnostics;
      /**
       * Installed only under the strict flag. Absent in development builds and
       * tree-shaken out of production ones entirely.
       */
      runSelectionExportProbe?: (request: {
        startTick: number;
        endTick: number;
      }) => Promise<unknown>;
    };
  }
}

/**
 * Read-only diagnostics gate (broad).
 *
 * CI serves a production `preview` build, so DEV alone is not enough; the
 * Playwright workflow builds with VITE_E2E_DIAGNOSTICS=true. DEV keeps the
 * local `npm run dev` e2e path working with no extra configuration. Getters
 * only — nothing here performs work or mutates state.
 */
function isReadOnlyDiagnosticsEnabled(): boolean {
  return (
    import.meta.env.VITE_E2E_DIAGNOSTICS === "true" || import.meta.env.DEV
  );
}

/**
 * Callable probe gate (strict).
 *
 * Deliberately *not* `|| DEV`. The export probe performs real work, so an
 * ordinary development build must not silently gain a work-performing
 * backdoor; the CI E2E build opts in explicitly. Because the condition is a
 * build-time constant, a production build folds it to `false` and Rollup drops
 * the dynamic import — verified by `scripts/verify-production-bundle.mjs`.
 */
function isCallableProbeEnabled(): boolean {
  return import.meta.env.VITE_E2E_DIAGNOSTICS === "true";
}

export function installE2EDiagnostics(): void {
  if (typeof window === "undefined") return;
  if (!isReadOnlyDiagnosticsEnabled()) return;

  window.__vloE2E = {
    getPlaybackDiagnostics: () => {
      const ctx = audioSystem.getContext();
      return {
        isPlaying: usePlayerStore.getState().isPlaying,
        playheadTicks: playbackClock.time,
        presentationFrameTicks: playbackFrameClock.time,
        audioTicks: audioSystem.getCurrentPlaybackTicks(),
        audioAnchorTime: audioSystem.getStartTime(),
        audioContextTime: ctx?.currentTime ?? null,
        audioContextState: ctx?.state ?? null,
        audioSampleRate: ctx?.sampleRate ?? null,
      };
    },
  };

  if (isCallableProbeEnabled()) {
    void import("./e2e/selectionExportProbe")
      .then(({ runSelectionExportProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.runSelectionExportProbe = runSelectionExportProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install selection export probe", error);
      });
  }
}
