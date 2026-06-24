import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugStore } from "../../../../../shared/debug/useDebugStore";
import {
  publishFramePlanningDiagnostics,
  startFramePlanningDiagnosticsConsole,
} from "../framePlanningDiagnostics";
import { createEmptyFramePlanningDiagnostics } from "../framePlanningTypes";

function diagnostics(overrides: { cacheHits?: number; stale?: number } = {}) {
  const d = createEmptyFramePlanningDiagnostics(1);
  d.jobsPlanned = 2;
  d.cacheHits = overrides.cacheHits ?? 1;
  d.staleGenerationsDropped = overrides.stale ?? 0;
  d.decodeTimeMs = 4;
  d.gpuTimeMs = 2;
  return d;
}

describe("startFramePlanningDiagnosticsConsole", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDebugStore.getState().setDebugMode(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    useDebugStore.getState().setDebugMode(false);
    vi.restoreAllMocks();
  });

  it("flushes one throttled summary for buffered frames when debug mode is on", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
    vi.spyOn(console, "groupEnd").mockImplementation(() => {});

    const stop = startFramePlanningDiagnosticsConsole();
    publishFramePlanningDiagnostics(diagnostics({ cacheHits: 1 }));
    publishFramePlanningDiagnostics(diagnostics({ cacheHits: 1, stale: 1 }));

    expect(table).not.toHaveBeenCalled(); // throttled
    vi.advanceTimersByTime(1500);

    expect(table).toHaveBeenCalledTimes(1);
    const [rows] = table.mock.calls[0] as [Array<Record<string, number>>];
    expect(rows[0].frames).toBe(2);
    expect(rows[0].cacheHits).toBe(2);
    expect(rows[0].staleDropped).toBe(1);
    stop();
  });

  it("logs nothing when debug mode is off (publish is gated)", () => {
    useDebugStore.getState().setDebugMode(false);
    const table = vi.spyOn(console, "table").mockImplementation(() => {});

    const stop = startFramePlanningDiagnosticsConsole();
    publishFramePlanningDiagnostics(diagnostics());
    vi.advanceTimersByTime(1500);

    expect(table).not.toHaveBeenCalled();
    stop();
  });

  it("cancels a pending flush when the subscriber stops", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => {});

    const stop = startFramePlanningDiagnosticsConsole();
    publishFramePlanningDiagnostics(diagnostics());
    stop();
    vi.advanceTimersByTime(1500);

    expect(table).not.toHaveBeenCalled();
  });
});
