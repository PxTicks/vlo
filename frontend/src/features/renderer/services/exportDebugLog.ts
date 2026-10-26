import type { ExportPhase } from "../../../core/export/exportProgress";
import { useDebugStore } from "../../../shared/debug/useDebugStore";
import type { ExportDiagnostic } from "./exportDiagnostics";

/** How often the running tally is printed while a render is in progress. */
export const EXPORT_DEBUG_SUMMARY_INTERVAL_MS = 10_000;

export interface ExportDebugLog {
  onPhaseChange: (phase: ExportPhase) => void;
  onDiagnostic: (event: ExportDiagnostic) => void;
  /** Log a one-off milestone, such as setup finishing, with the elapsed time. */
  mark: (milestone: string) => void;
  /** Print the final tally and stop the periodic summary. Idempotent. */
  finish: (outcome: "completed" | "failed" | "cancelled") => void;
}

/**
 * Console diagnostics for one render, when debug mode is on as it starts.
 *
 * The questions this answers are the ones export slowness keeps raising: which
 * encoder did the browser pick, is rendering or encoding the slower stage (a
 * growing backlog means encoding), and which finishing step takes the time.
 * Returns null outside debug mode, so a normal render pays nothing — not even
 * the encoder's per-packet timing bookkeeping, which only runs when someone
 * listens.
 */
export function startExportDebugLog(label: string): ExportDebugLog | null {
  if (!useDebugStore.getState().debugMode) return null;

  const startedAt = performance.now();
  const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  const log = (...values: unknown[]) => console.info(`[Export debug: ${label}]`, elapsed(), ...values);

  let frames = 0;
  let packets = 0;
  let windowFrames = 0;
  let windowRenderMs = 0;
  let windowOutputMs = 0;
  let latestLatencyMs: number | null = null;
  let finished = false;
  // Whole-render totals, so the final line shows how much of the wall time
  // was frame work and how much was waiting (scheduling, a hidden tab).
  let totalRenderMs = 0;
  let totalOutputMs = 0;
  const phaseDurations = new Map<ExportPhase, number>();
  let currentPhase: { phase: ExportPhase; startedAt: number } | null = null;
  const closePhase = () => {
    if (!currentPhase) return;
    const { phase, startedAt: phaseStartedAt } = currentPhase;
    phaseDurations.set(phase, (phaseDurations.get(phase) ?? 0) + performance.now() - phaseStartedAt);
    currentPhase = null;
  };
  const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)} s`;

  const summarize = () => {
    const perFrame = (total: number) => (windowFrames ? (total / windowFrames).toFixed(1) : "-");
    log(
      `submitted ${frames}, encoded ${packets}, backlog ${frames - packets}`,
      `| last ${windowFrames} frames: render ${perFrame(windowRenderMs)} ms, output ${perFrame(windowOutputMs)} ms each`,
      latestLatencyMs === null ? "" : `| submit→packet ${(latestLatencyMs / 1000).toFixed(1)} s`,
    );
    windowFrames = 0;
    windowRenderMs = 0;
    windowOutputMs = 0;
  };
  const timer = setInterval(summarize, EXPORT_DEBUG_SUMMARY_INTERVAL_MS);

  log("started");
  return {
    onPhaseChange: (phase) => {
      closePhase();
      currentPhase = { phase, startedAt: performance.now() };
      log("phase", phase);
    },
    onDiagnostic: (event) => {
      switch (event.kind) {
        case "frame":
          frames += 1;
          windowFrames += 1;
          windowRenderMs += event.renderMilliseconds;
          windowOutputMs += event.outputMilliseconds;
          totalRenderMs += event.renderMilliseconds;
          totalOutputMs += event.outputMilliseconds;
          break;
        case "video-packet":
          packets += 1;
          latestLatencyMs = event.submissionToPacketMilliseconds ?? latestLatencyMs;
          break;
        case "encoder-config": {
          const { codec, width, height, hardwareAcceleration, latencyMode, bitrate } = event.config;
          // The config is a request. chrome://media-internals names the encoder
          // the browser actually chose, and whether it is hardware.
          log(`encoder for '${event.outputId}': ${codec} ${width}x${height},`,
            `acceleration ${hardwareAcceleration ?? "unset"}, latency ${latencyMode ?? "unset"},`,
            `bitrate ${bitrate ?? "unset"} (chrome://media-internals shows the encoder actually used)`);
          break;
        }
        case "finishing":
          if (event.state === "completed") {
            log(`finished ${event.stage}${event.outputId ? ` (${event.outputId})` : ""}`,
              `${((event.elapsedMilliseconds ?? 0) / 1000).toFixed(2)} s`);
          }
          break;
        default:
          break;
      }
    },
    mark: (milestone) => log(milestone),
    finish: (outcome) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      closePhase();
      log(outcome, `: ${frames} frames submitted, ${packets} packets encoded`,
        `| frame work: render ${seconds(totalRenderMs)}, output ${seconds(totalOutputMs)}`,
        `of ${seconds(performance.now() - startedAt)} wall`,
        `| phases: ${[...phaseDurations].map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(", ") || "none"}`);
    },
  };
}
