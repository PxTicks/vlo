import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugStore } from "../../../../shared/debug/useDebugStore";
import {
  createDecoderDiagnosticMessage,
  createDecoderRequestDiagnostics,
  isDecoderDiagnosticMessage,
  isDecoderDiagnosticsEnabled,
  isDecoderWorkerHealthMessage,
  logDecoderDiagnostic,
  logDecoderRequestAborted,
  logDecoderRequestSent,
  logDecoderRequestTimeout,
  logDecoderWorkerPhase,
} from "../decoderDiagnostics";

describe("decoderDiagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDebugStore.getState().setDebugMode(false);
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
  });

  afterEach(() => {
    useDebugStore.getState().setDebugMode(false);
    vi.advanceTimersByTime(1200);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not create or log diagnostics while debug mode is disabled", () => {
    expect(isDecoderDiagnosticsEnabled()).toBe(false);
    expect(
      createDecoderRequestDiagnostics({
        source: "track",
        requestType: "render",
        clipId: "clip-1",
      }),
    ).toBeUndefined();
    logDecoderRequestSent(undefined);
    logDecoderRequestTimeout(undefined);
    logDecoderRequestAborted(undefined);
    logDecoderWorkerPhase(undefined, "worker:render:posted-frame");
    expect(console.groupCollapsed).not.toHaveBeenCalled();
  });

  it("creates unique request and phase messages", () => {
    useDebugStore.getState().setDebugMode(true);
    const first = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "render",
      clipId: "clip-1",
      label: "preview",
    });
    const second = createDecoderRequestDiagnostics({
      source: "mask",
      requestType: "prepare",
      clipId: "clip-2",
    });

    expect(first).toMatchObject({
      traceId: expect.stringMatching(/^track:render:/),
      requestedAtMs: expect.any(Number),
      label: "preview",
    });
    expect(second?.traceId).not.toBe(first?.traceId);
    expect(
      createDecoderDiagnosticMessage(first!, "main:send", { strict: true }),
    ).toEqual({
      ...first,
      type: "diagnostic",
      phase: "main:send",
      detail: { strict: true },
    });
  });

  it.each([
    [null, false],
    [{}, false],
    [{ type: "diagnostic", traceId: 1, phase: "done" }, false],
    [{ type: "diagnostic", traceId: "t", phase: 1 }, false],
    [{ type: "diagnostic", traceId: "t", phase: "done" }, true],
  ])("validates diagnostic messages", (value, expected) => {
    expect(isDecoderDiagnosticMessage(value)).toBe(expected);
  });

  it.each([
    [null, false],
    [{}, false],
    [{ type: "worker-health", event: "unknown" }, false],
    [{ type: "worker-health", event: "boot" }, true],
    [{ type: "worker-health", event: "pong", pingId: "p1" }, true],
  ])("validates worker health messages", (value, expected) => {
    expect(isDecoderWorkerHealthMessage(value)).toBe(expected);
  });

  it("summarizes a successful worker trace with rounded timings", () => {
    useDebugStore.getState().setDebugMode(true);
    const diagnostics = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "render",
      clipId: "clip-1",
      label: "main",
    })!;

    vi.advanceTimersByTime(10.26);
    logDecoderRequestSent(diagnostics, {
      fileSizeMB: 12,
      sourceScheme: "blob",
      time: 1.5,
      strict: true,
    });
    vi.advanceTimersByTime(20.35);
    logDecoderWorkerPhase(
      diagnostics,
      "worker:render:received",
      undefined,
      4.26,
    );
    vi.advanceTimersByTime(30.44);
    logDecoderWorkerPhase(
      diagnostics,
      "worker:render:queued-behind-active",
      undefined,
      8.88,
    );
    vi.advanceTimersByTime(40.55);
    logDecoderWorkerPhase(
      diagnostics,
      "worker:render:posted-frame",
      { frame: 2 },
      15.55,
    );
    vi.advanceTimersByTime(1200);

    expect(console.groupCollapsed).toHaveBeenCalledWith(
      expect.stringContaining("1 request summary"),
    );
    expect(console.groupCollapsed).toHaveBeenCalledWith(
      expect.stringContaining("1 queued"),
    );
    expect(console.table).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "track",
        kind: "render",
        clipId: "clip-1",
        label: "main",
        status: "ok",
        workerMs: 15.6,
        fileMB: 12,
        scheme: "blob",
        mediaTime: 1.5,
        strict: true,
      }),
    ]);
  });

  it("summarizes timeout and abort details", () => {
    useDebugStore.getState().setDebugMode(true);
    const timeout = createDecoderRequestDiagnostics({
      source: "pool",
      requestType: "worker",
      clipId: "worker-1",
    })!;
    const aborted = createDecoderRequestDiagnostics({
      source: "mask",
      requestType: "prepare",
      clipId: "mask-1",
    })!;

    logDecoderRequestTimeout(timeout, { timeoutMs: 500 });
    logDecoderRequestAborted(aborted, { reason: "superseded" });
    vi.advanceTimersByTime(1200);

    expect(console.table).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          status: "timeout",
          timeoutMs: 500,
        }),
        expect.objectContaining({
          status: "main:abort",
          abortReason: "superseded",
        }),
      ]),
    );
  });

  it("keeps nonterminal traces pending and later marks them stale", () => {
    useDebugStore.getState().setDebugMode(true);
    const diagnostics = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "prepare",
      clipId: "clip-stale",
    })!;
    logDecoderDiagnostic(
      createDecoderDiagnosticMessage(diagnostics, "worker:prepare:received"),
    );

    vi.advanceTimersByTime(1200);
    expect(console.table).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    expect(console.table).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "main:stale",
        staleTraceMs: 8000,
      }),
    ]);
  });

  it("clears pending traces if debug mode is disabled before flush", () => {
    useDebugStore.getState().setDebugMode(true);
    const diagnostics = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "render",
      clipId: "clip-1",
    })!;
    logDecoderRequestSent(diagnostics);
    useDebugStore.getState().setDebugMode(false);
    vi.advanceTimersByTime(1200);
    expect(console.table).not.toHaveBeenCalled();
  });
});
