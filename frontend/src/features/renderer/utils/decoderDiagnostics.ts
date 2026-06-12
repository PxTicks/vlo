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

const DECODER_DIAGNOSTICS_STORAGE_KEY = "vlo:decoder-diagnostics";

let nextTraceId = 0;

function getDiagnosticsGlobalFlag(): boolean {
  return (
    (globalThis as { __VLO_DECODER_DIAGNOSTICS__?: unknown })
      .__VLO_DECODER_DIAGNOSTICS__ === true
  );
}

export function isDecoderDiagnosticsEnabled(): boolean {
  if (getDiagnosticsGlobalFlag()) {
    return true;
  }

  try {
    if (typeof localStorage === "undefined") {
      return false;
    }

    const value = localStorage.getItem(DECODER_DIAGNOSTICS_STORAGE_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
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
  const mainElapsedMs = performance.now() - message.requestedAtMs;
  console.info("[vlo decoder]", message.phase, {
    traceId: message.traceId,
    source: message.source,
    requestType: message.requestType,
    clipId: message.clipId,
    label: message.label,
    mainElapsedMs: Number(mainElapsedMs.toFixed(1)),
    workerElapsedMs:
      typeof message.workerElapsedMs === "number"
        ? Number(message.workerElapsedMs.toFixed(1))
        : undefined,
    ...message.detail,
  });
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
