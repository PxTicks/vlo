import { playbackClock, playbackFrameClock } from "../core/playback/PlaybackClock";
import { audioSystem } from "../features/player/services/AudioSystem";
import { usePlayerStore } from "../features/player/usePlayerStore";
import { useMaskViewStore } from "../features/masks";
import {
  getSelectedTimelineClipId,
  getTimelineViewGeometry,
} from "../features/timeline/api";
import { TRACK_HEADER_WIDTH } from "../features/timeline/constants";

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

/**
 * Timeline geometry for a given tick, so a test can click the ruler at an exact
 * project tick instead of a brittle fraction of the ruler width.
 *
 * `absolutePx` comes from the production view store's `ticksToPx`, so a seek
 * helper is anchored to the app's own tick→pixel math rather than a test-only
 * reimplementation that could agree while the app is wrong. The header width
 * and scroll offset (read from the DOM by the caller) still have to be applied
 * to turn this into a click coordinate — the ruler's own scrub handler does the
 * same: `x = ticksToPx(t) + TRACK_HEADER_WIDTH - scrollLeft`.
 */
export interface E2ETimelineTickGeometry {
  absolutePx: number;
  trackHeaderWidth: number;
  zoomScale: number;
  playheadTicks: number;
}

/** SAM2 preview state for the selected clip, as the player reads it. */
export interface E2ESam2PreviewDiagnostics {
  selectedClipId: string | null;
  /** Whether a live SAM2 preview frame is held for the selected clip. */
  hasLivePreview: boolean;
}

declare global {
  interface Window {
    __vloE2E?: {
      getPlaybackDiagnostics: () => E2EPlaybackDiagnostics;
      getTimelineTickGeometry: (tick: number) => E2ETimelineTickGeometry;
      getSam2PreviewDiagnostics: () => E2ESam2PreviewDiagnostics;
      /**
       * Installed only under the strict flag. Absent in development builds and
       * tree-shaken out of production ones entirely.
       */
      runSelectionExportProbe?: (request: {
        startTick: number;
        endTick: number;
        legacyReplay?: boolean;
      }) => Promise<unknown>;
      runGlitchConsistencyProbe?: () => Promise<unknown>;
      runProjectExportPixelProbe?: (request: {
        samples: { frame: number; rect: [number, number, number, number] }[];
      }) => Promise<unknown>;
      captureDetachedRenderProbeInput?: () => Promise<unknown>;
      setExportDebugMode?: (on: boolean) => void;
      getLatestExportRunSummary?: () => unknown;
      runDetachedRenderPixelProbe?: (request: {
        input: { document: unknown; files: Record<string, string> };
        samples: { frame: number; rect: [number, number, number, number] }[];
      }) => Promise<unknown>;
      runRgbSplitConsistencyProbe?: () => Promise<unknown>;
      runMaskDistanceFieldProbe?: () => Promise<unknown>;
      runCompositeParityProbe?: (request: {
        compositeId: string;
        placementTick: number;
      }) => Promise<unknown>;
      /**
       * True only while the canonical parity probe needs the live renderer to
       * omit interactive preview demand and use its source-fidelity policy.
       */
      requiresSourceFidelityCompositeFrame?: () => boolean;
      /**
       * Internal synchronous receiver. The player calls it before releasing
       * the live Pixi texture; it is present only in strict diagnostic builds.
       */
      acceptLiveCompositeFrame?: (frame: {
        compositeId: string;
        localPresentationTick: number;
        width: number;
        height: number;
        pixels: Uint8ClampedArray;
      }) => void;
      rejectLiveCompositeFrame?: (error: string) => void;
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
    getTimelineTickGeometry: (tick: number) => {
      const view = getTimelineViewGeometry(tick);
      return {
        absolutePx: view.absolutePx,
        trackHeaderWidth: TRACK_HEADER_WIDTH,
        zoomScale: view.zoomScale,
        playheadTicks: playbackClock.time,
      };
    },
    getSam2PreviewDiagnostics: () => {
      const selectedClipId = getSelectedTimelineClipId();
      return {
        selectedClipId,
        hasLivePreview:
          selectedClipId !== null &&
          Boolean(
            useMaskViewStore.getState().sam2LivePreviewByClipId[selectedClipId],
          ),
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
    void import("./e2e/projectExportPixelProbe")
      .then(({ runProjectExportPixelProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.runProjectExportPixelProbe = runProjectExportPixelProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install project export pixel probe", error);
      });
    void import("./e2e/detachedRenderProbe")
      .then(({ captureDetachedRenderProbeInput, runDetachedRenderPixelProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.captureDetachedRenderProbeInput = captureDetachedRenderProbeInput;
          window.__vloE2E.runDetachedRenderPixelProbe = runDetachedRenderPixelProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install detached render probe", error);
      });
    void import("./e2e/exportMeasureHooks")
      .then(({ setExportDebugMode, getLatestExportRunSummary }) => {
        if (window.__vloE2E) {
          window.__vloE2E.setExportDebugMode = setExportDebugMode;
          window.__vloE2E.getLatestExportRunSummary = getLatestExportRunSummary;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install export measure hooks", error);
      });
    void import("./e2e/glitchConsistencyProbe")
      .then(({ runGlitchConsistencyProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.runGlitchConsistencyProbe = runGlitchConsistencyProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install Glitch consistency probe", error);
      });
    void import("./e2e/maskDistanceFieldProbe")
      .then(({ runMaskDistanceFieldProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.runMaskDistanceFieldProbe = runMaskDistanceFieldProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install mask distance-field probe", error);
      });
    void import("./e2e/rgbSplitConsistencyProbe")
      .then(({ runRgbSplitConsistencyProbe }) => {
        if (window.__vloE2E) {
          window.__vloE2E.runRgbSplitConsistencyProbe =
            runRgbSplitConsistencyProbe;
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to install RGB Split consistency probe", error);
      });
    void import("./e2e/compositeParityProbe")
      .then(
        ({
          acceptLiveCompositeFrame,
          rejectLiveCompositeFrame,
          requiresSourceFidelityCompositeFrame,
          runCompositeParityProbe,
        }) => {
          if (window.__vloE2E) {
            window.__vloE2E.acceptLiveCompositeFrame =
              acceptLiveCompositeFrame;
            window.__vloE2E.rejectLiveCompositeFrame =
              rejectLiveCompositeFrame;
            window.__vloE2E.requiresSourceFidelityCompositeFrame =
              requiresSourceFidelityCompositeFrame;
            window.__vloE2E.runCompositeParityProbe =
              runCompositeParityProbe;
          }
        },
      )
      .catch((error: unknown) => {
        console.error("Failed to install composite parity probe", error);
      });
  }
}
