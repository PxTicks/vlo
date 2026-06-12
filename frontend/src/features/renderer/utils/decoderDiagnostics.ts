import { useDebugStore } from "../../../shared/debug/useDebugStore";

export type DecoderDiagnosticSource = "track" | "mask";
export type DecoderDiagnosticRequestType = "prepare" | "render";

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

  const traces = [...pendingTraces.values()];
  pendingTraces.clear();

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

  console.groupCollapsed(
    `[vlo decoder] ${traces.length} request summary (${roundMs(
      endedAtMs - startedAtMs,
    )}ms, ${timedOutCount} timed out, ${queuedCount} queued)`,
  );
  console.table(traces.map(createSummaryRow));
  console.log(
    "Phases by trace",
    traces.map((trace) => ({
      traceId: trace.traceId,
      phases: trace.phases.map((phase) => ({
        phase: phase.phase,
        mainElapsedMs: roundMs(phase.mainElapsedMs),
        workerElapsedMs: roundMs(phase.workerElapsedMs),
        detail: phase.detail,
      })),
    })),
  );
  console.groupEnd();
}

function createSummaryRow(trace: DecoderDiagnosticTrace): Record<string, unknown> {
  const firstPhase = trace.phases[0];
  const lastPhase = trace.phases[trace.phases.length - 1];
  const sendPhase = trace.phases.find((phase) => phase.phase === "main:send");
  const timeoutPhase = trace.phases.find(
    (phase) => phase.phase === "main:timeout",
  );
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
  };
}
