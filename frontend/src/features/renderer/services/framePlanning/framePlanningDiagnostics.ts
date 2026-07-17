import { useDebugStore } from "../../../../shared/debug/useDebugStore";
import type { FramePlanningDiagnostics } from "./framePlanningTypes";

let latest: FramePlanningDiagnostics | null = null;
const listeners = new Set<(diagnostics: FramePlanningDiagnostics) => void>();

export function publishFramePlanningDiagnostics(
  diagnostics: FramePlanningDiagnostics,
): void {
  if (!useDebugStore.getState().debugMode) {
    return;
  }
  latest = diagnostics;
  for (const listener of listeners) {
    listener(diagnostics);
  }
}

export function getLatestFramePlanningDiagnostics(): FramePlanningDiagnostics | null {
  return latest;
}

export function subscribeFramePlanningDiagnostics(
  listener: (diagnostics: FramePlanningDiagnostics) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearFramePlanningDiagnostics(): void {
  latest = null;
}

const CONSOLE_FLUSH_DELAY_MS = 1500;

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Subscribe a throttled console summary to published diagnostics. Publishing is
 * already debug-gated, so nothing logs unless `debugMode` is on. Returns an
 * unsubscribe for the caller (e.g. a Player effect cleanup).
 */
export function startFramePlanningDiagnosticsConsole(): () => void {
  const buffer: FramePlanningDiagnostics[] = [];
  let flushHandle: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    flushHandle = null;
    if (buffer.length === 0) return;
    const frames = buffer.splice(0, buffer.length);
    const sum = (pick: (d: FramePlanningDiagnostics) => number): number =>
      frames.reduce((total, frame) => total + pick(frame), 0);
    const max = (pick: (d: FramePlanningDiagnostics) => number): number =>
      frames.reduce((peak, frame) => Math.max(peak, pick(frame)), 0);

    const summary = {
      frames: frames.length,
      jobsPerFrame: roundMs(sum((d) => d.jobsPlanned) / frames.length),
      withinFrameDedupHits: sum((d) => d.withinFrameDedupHits),
      cacheHits: sum((d) => d.cacheHits),
      cacheMisses: sum((d) => d.cacheMisses),
      staleDropped: sum((d) => d.staleGenerationsDropped),
      compositeLiveJobs: sum((d) => d.compositeLiveJobs),
      compositeBakedJobs: sum((d) => d.compositeBakedJobs),
      compositeFailures: sum((d) => d.compositeNodeFailures),
      compositeSwitches: sum((d) => d.compositeSourceSwitches),
      compositeSwitchLatencyMs: roundMs(
        sum((d) => d.compositeSwitchLatencyMs),
      ),
      compositeRenderDedupHits: sum((d) => d.compositeRenderDedupHits),
      peakCompositeRuntimes: max((d) => d.compositeRuntimeCount),
      peakCompositePooledRuntimes: max(
        (d) => d.compositePooledRuntimeCount,
      ),
      peakCompositeTextureBytes: max((d) => d.compositeTextureBytes),
      peakCompositeLeases: max((d) => d.compositeOutstandingLeases),
      avgDecodeMs: roundMs(sum((d) => d.decodeTimeMs) / frames.length),
      avgGpuMs: roundMs(sum((d) => d.gpuTimeMs) / frames.length),
      peakResidentSources: max((d) => d.residentSourceResources),
      peakOutstandingLeases: max((d) => d.outstandingLeases),
    };

    console.groupCollapsed(
      `[vlo frame-plan] ${summary.frames} frames ` +
        `(${summary.cacheHits} cache hits, ${summary.staleDropped} stale dropped)`,
    );
    console.table([summary]);
    console.groupEnd();
  };

  const unsubscribe = subscribeFramePlanningDiagnostics((diagnostics) => {
    buffer.push(diagnostics);
    if (flushHandle === null) {
      flushHandle = setTimeout(flush, CONSOLE_FLUSH_DELAY_MS);
    }
  });

  return () => {
    unsubscribe();
    if (flushHandle !== null) {
      clearTimeout(flushHandle);
      flushHandle = null;
    }
    buffer.length = 0;
  };
}
