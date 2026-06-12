import { useDebugStore } from "../../../shared/debug/useDebugStore";

export type DecoderDiagnosticSource = "track" | "mask";
export type DecoderDiagnosticRequestType = "prepare" | "render" | "worker";

export interface DecoderWorkerHealthMessage {
  type: "worker-health";
  event: "boot" | "pong";
  pingId?: string;
  workerElapsedMs?: number;
  detail?: Record<string, unknown>;
}

export interface DecoderRequestDiagnostics {
  traceId: string;
  source: DecoderDiagnosticSource;
  requestType: DecoderDiagnosticRequestType;
  clipId: string;
  requestedAtMs: number;
  label?: string;
}

export interface DecoderDiagnosticMessage extends DecoderRequestDiagnostics {
  type: "diagnostic";
  phase: string;
  workerElapsedMs?: number;
  detail?: Record<string, unknown>;
}

interface DecoderDiagnosticPhase {
  detail?: Record<string, unknown>;
  mainElapsedMs: number;
  phase: string;
  workerElapsedMs?: number;
}

interface DecoderDiagnosticTrace extends DecoderRequestDiagnostics {
  phases: DecoderDiagnosticPhase[];
}

const DECODER_DIAGNOSTICS_FLUSH_DELAY_MS = 1200;
const DECODER_DIAGNOSTICS_STALE_TRACE_MS = 8000;
let nextTraceId = 0;
let flushHandle: ReturnType<typeof setTimeout> | null = null;
const pendingTraces = new Map<string, DecoderDiagnosticTrace>();

function roundMs(value: number | undefined): number | undefined {
  return typeof value === "number" ? Number(value.toFixed(1)) : undefined;
}

export function isDecoderDiagnosticsEnabled(): boolean {
  return useDebugStore.getState().debugMode;
}

export function createDecoderRequestDiagnostics(options: {
  source: DecoderDiagnosticSource;
  requestType: DecoderDiagnosticRequestType;
  clipId: string;
  label?: string;
}): DecoderRequestDiagnostics | undefined {
  if (!isDecoderDiagnosticsEnabled()) {
    return undefined;
  }

  nextTraceId += 1;
  return {
    traceId: `${options.source}:${options.requestType}:${nextTraceId}`,
    source: options.source,
    requestType: options.requestType,
    clipId: options.clipId,
    requestedAtMs: performance.now(),
    label: options.label,
  };
}

export function createDecoderDiagnosticMessage(
  diagnostics: DecoderRequestDiagnostics,
  phase: string,
  detail?: Record<string, unknown>,
): DecoderDiagnosticMessage {
  return {
    ...diagnostics,
    type: "diagnostic",
    phase,
    detail,
  };
}

export function isDecoderDiagnosticMessage(
  value: unknown,
): value is DecoderDiagnosticMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    (value as { type?: unknown }).type === "diagnostic" &&
    typeof (value as { traceId?: unknown }).traceId === "string" &&
    typeof (value as { phase?: unknown }).phase === "string"
  );
}

export function isDecoderWorkerHealthMessage(
  value: unknown,
): value is DecoderWorkerHealthMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    (value as { type?: unknown }).type === "worker-health" &&
    ["boot", "pong"].includes(String((value as { event?: unknown }).event))
  );
}

export function logDecoderDiagnostic(
  message: DecoderDiagnosticMessage,
): void {
  if (!isDecoderDiagnosticsEnabled()) {
    return;
  }

  const trace =
    pendingTraces.get(message.traceId) ??
    ({
      traceId: message.traceId,
      source: message.source,
      requestType: message.requestType,
      clipId: message.clipId,
      requestedAtMs: message.requestedAtMs,
      label: message.label,
      phases: [],
    } satisfies DecoderDiagnosticTrace);

  trace.phases.push({
    phase: message.phase,
    mainElapsedMs: performance.now() - message.requestedAtMs,
    workerElapsedMs: message.workerElapsedMs,
    detail: message.detail,
  });
  pendingTraces.set(message.traceId, trace);
  scheduleDecoderDiagnosticSummary();
}

export function logDecoderRequestSent(
  diagnostics: DecoderRequestDiagnostics | undefined,
  detail?: Record<string, unknown>,
): void {
  if (!diagnostics) {
    return;
  }

  logDecoderDiagnostic(
    createDecoderDiagnosticMessage(diagnostics, "main:send", detail),
  );
}

export function logDecoderRequestTimeout(
  diagnostics: DecoderRequestDiagnostics | undefined,
  detail?: Record<string, unknown>,
): void {
  if (!diagnostics) {
    return;
  }

  logDecoderDiagnostic(
    createDecoderDiagnosticMessage(diagnostics, "main:timeout", detail),
  );
}

export function logDecoderRequestAborted(
  diagnostics: DecoderRequestDiagnostics | undefined,
  detail?: Record<string, unknown>,
): void {
  if (!diagnostics) {
    return;
  }

  logDecoderDiagnostic(
    createDecoderDiagnosticMessage(diagnostics, "main:abort", detail),
  );
}

export function logDecoderWorkerPhase(
  diagnostics: DecoderRequestDiagnostics | undefined,
  phase: string,
  detail?: Record<string, unknown>,
  workerElapsedMs?: number,
): void {
  if (!diagnostics) {
    return;
  }

  logDecoderDiagnostic({
    ...createDecoderDiagnosticMessage(diagnostics, phase, detail),
    workerElapsedMs,
  });
}

function scheduleDecoderDiagnosticSummary(): void {
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
  }

  flushHandle = setTimeout(() => {
    flushHandle = null;
    flushDecoderDiagnosticSummary();
  }, DECODER_DIAGNOSTICS_FLUSH_DELAY_MS);
}

function flushDecoderDiagnosticSummary(): void {
  if (pendingTraces.size === 0) {
    return;
  }

  if (!isDecoderDiagnosticsEnabled()) {
    pendingTraces.clear();
    return;
  }

  const nowMs = performance.now();
  const traces = [...pendingTraces.values()].filter((trace) => {
    if (trace.phases.some((phase) => isTerminalDiagnosticPhase(phase.phase))) {
      return true;
    }

    if (nowMs - trace.requestedAtMs < DECODER_DIAGNOSTICS_STALE_TRACE_MS) {
      return false;
    }

    trace.phases.push({
      phase: "main:stale",
      mainElapsedMs: nowMs - trace.requestedAtMs,
      detail: { staleTraceMs: DECODER_DIAGNOSTICS_STALE_TRACE_MS },
    });
    return true;
  });
  for (const trace of traces) {
    pendingTraces.delete(trace.traceId);
  }

  if (traces.length === 0) {
    scheduleDecoderDiagnosticSummary();
    return;
  }

  const startedAtMs = Math.min(...traces.map((trace) => trace.requestedAtMs));
  const endedAtMs = Math.max(
    ...traces.flatMap((trace) =>
      trace.phases.map((phase) => trace.requestedAtMs + phase.mainElapsedMs),
    ),
  );
  const timedOutCount = traces.filter((trace) =>
    trace.phases.some((phase) => phase.phase === "main:timeout"),
  ).length;
  const queuedCount = traces.filter((trace) =>
    trace.phases.some((phase) => phase.phase === "worker:render:queued-behind-active"),
  ).length;
  const summaryRows = traces.map(createSummaryRow);
  const phaseRows = traces.map((trace) => ({
    traceId: trace.traceId,
    phases: trace.phases.map((phase) => ({
      phase: phase.phase,
      mainElapsedMs: roundMs(phase.mainElapsedMs),
      workerElapsedMs: roundMs(phase.workerElapsedMs),
      detail: phase.detail,
    })),
  }));

  console.groupCollapsed(
    `[vlo decoder] ${traces.length} request summary (${roundMs(
      endedAtMs - startedAtMs,
    )}ms, ${timedOutCount} timed out, ${queuedCount} queued)`,
  );
  console.log("Summary rows", summaryRows);
  console.table(summaryRows);
  console.log("Phases by trace", phaseRows);
  console.groupEnd();

  if (pendingTraces.size > 0) {
    scheduleDecoderDiagnosticSummary();
  }
}

function isTerminalDiagnosticPhase(phase: string): boolean {
  return [
    "main:abort",
    "main:stale",
    "main:timeout",
    "worker:prepare:posted-ready",
    "worker:prepare:posted-ready-existing",
    "worker:prepare:error",
    "worker:render:posted-frame",
    "worker:render:missing-renderer",
    "worker:render:disposed",
    "worker:render:error",
    "worker:health:pong",
    "main:worker:error",
    "main:worker:messageerror",
    "main:worker:ping:timeout",
    "main:worker:terminated",
  ].includes(phase);
}

function createSummaryRow(trace: DecoderDiagnosticTrace): Record<string, unknown> {
  const firstPhase = trace.phases[0];
  const lastPhase = trace.phases[trace.phases.length - 1];
  const sendPhase = trace.phases.find((phase) => phase.phase === "main:send");
  const timeoutPhase = trace.phases.find(
    (phase) => phase.phase === "main:timeout",
  );
  const abortPhase = trace.phases.find((phase) => phase.phase === "main:abort");
  const stalePhase = trace.phases.find((phase) => phase.phase === "main:stale");
  const workerReceivedPhase = trace.phases.find((phase) =>
    phase.phase.endsWith(":received"),
  );
  const workerDonePhase = [...trace.phases]
    .reverse()
    .find((phase) =>
      [
        "worker:prepare:posted-ready",
        "worker:prepare:posted-ready-existing",
        "worker:render:posted-frame",
        "worker:health:pong",
      ].includes(phase.phase),
    );
  const maxWorkerElapsedMs = Math.max(
    0,
    ...trace.phases.map((phase) => phase.workerElapsedMs ?? 0),
  );
  const maxMainElapsedMs = Math.max(
    0,
    ...trace.phases.map((phase) => phase.mainElapsedMs),
  );
  const sendDetail = sendPhase?.detail ?? firstPhase?.detail ?? {};

  return {
    traceId: trace.traceId,
    source: trace.source,
    kind: trace.requestType,
    clipId: trace.clipId,
    label: trace.label ?? "",
    status: timeoutPhase
      ? "timeout"
      : workerDonePhase
        ? "ok"
        : lastPhase?.phase ?? "pending",
    mainMs: roundMs(maxMainElapsedMs),
    workerMs: roundMs(maxWorkerElapsedMs),
    workerStartMs: roundMs(workerReceivedPhase?.mainElapsedMs),
    completeMs: roundMs(workerDonePhase?.mainElapsedMs),
    phaseCount: trace.phases.length,
    fileMB: sendDetail.fileSizeMB ?? "",
    scheme: sendDetail.sourceScheme ?? "",
    mediaTime: sendDetail.time ?? "",
    strict: sendDetail.strict ?? "",
    timeoutMs: sendDetail.timeoutMs ?? timeoutPhase?.detail?.timeoutMs ?? "",
    abortReason: abortPhase?.detail?.reason ?? "",
    staleTraceMs: stalePhase?.detail?.staleTraceMs ?? "",
  };
}
