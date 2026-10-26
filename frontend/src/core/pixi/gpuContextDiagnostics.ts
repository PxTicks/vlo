import type { Application } from "pixi.js";

/**
 * WebGL context lifecycle log, for diagnosing preview context losses.
 *
 * The player rarely loses its context for reasons of its own. The usual causes
 * are a GPU reset or out-of-memory (every live context dies together) or the
 * browser's active-context cap (only the oldest context dies, which is the
 * player). Telling those apart needs to know which other contexts existed at
 * the time, and offscreen renderers (generation inputs, exports, bakes) come
 * and go within seconds, so nothing else would remember them.
 */

export type GpuContextOwner = "player" | "offscreen-render";

type GlContext = WebGLRenderingContext | WebGL2RenderingContext;

interface GpuContextRecord {
  readonly id: number;
  readonly owner: GpuContextOwner;
  readonly width: number;
  readonly height: number;
  readonly createdAt: number;
  readonly gl: GlContext | null;
  lostAt: number | null;
}

type GpuContextEventKind =
  | "created"
  | "init-failed"
  | "lost"
  | "restored"
  | "disposed";

interface GpuContextEvent {
  readonly at: number;
  readonly kind: GpuContextEventKind;
  readonly id: number | null;
  readonly owner: GpuContextOwner;
  readonly width: number;
  readonly height: number;
  readonly detail?: string;
}

export interface GpuContextRegistration {
  /** Call before destroying the app: Pixi's destroy fires a context loss. */
  dispose(): void;
}

const EVENT_LOG_LIMIT = 64;
// In a GPU reset sibling contexts lose within a few ms of each other. Waiting
// briefly lets the report say whether the loss was shared.
const LOSS_REPORT_DELAY_MS = 500;

let nextContextId = 1;
const liveContexts = new Map<number, GpuContextRecord>();
const events: GpuContextEvent[] = [];
let pendingLossReport: ReturnType<typeof setTimeout> | null = null;
// Held apart from `liveContexts`: owners usually retire a lost app before the
// report runs, and the report still needs to name it.
let lostInWindow: GpuContextRecord[] = [];
let lossStatusMessage = "";
let gpuDescription: string | null | undefined;

function pushEvent(event: GpuContextEvent): void {
  events.push(event);
  if (events.length > EVENT_LOG_LIMIT) events.shift();
}

function readGl(application: Application): GlContext | null {
  const renderer = application.renderer as unknown as
    | { gl?: GlContext }
    | undefined;
  return renderer?.gl ?? null;
}

function describeGpu(gl: GlContext | null): string | null {
  if (gpuDescription !== undefined || !gl) return gpuDescription ?? null;
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const value = gl.getParameter(
      info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
    );
    gpuDescription = typeof value === "string" ? value : null;
  } catch {
    gpuDescription = null;
  }
  return gpuDescription;
}

function readHeapMegabytes(): string | null {
  // Chromium-only, non-standard.
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }
  ).memory;
  if (!memory) return null;
  const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `${toMb(memory.usedJSHeapSize)} / ${toMb(memory.jsHeapSizeLimit)} MB`;
}

function formatEvent(event: GpuContextEvent, reference: number): string {
  const offset = ((event.at - reference) / 1000).toFixed(2);
  const id = event.id === null ? "-" : `#${event.id}`;
  const detail = event.detail ? ` (${event.detail})` : "";
  return `${offset}s ${event.kind} ${id} ${event.owner} ${event.width}x${event.height}${detail}`;
}

function classifyLoss(
  lost: readonly GpuContextRecord[],
  survivors: readonly GpuContextRecord[],
): string {
  if (survivors.length === 0 && lost.length > 1) {
    return "every live context was lost: points to a GPU reset or GPU memory exhaustion";
  }
  if (survivors.length === 0) {
    return "the only live context was lost: GPU reset, memory exhaustion, or a driver fault (can't tell with one context)";
  }
  const oldest = [...lost, ...survivors].sort(
    (a, b) => a.createdAt - b.createdAt,
  )[0];
  if (lost.length === 1 && lost[0] === oldest) {
    return "only the oldest context was lost while others survived: points to the browser's active-context limit";
  }
  return "some contexts were lost while others survived: no clear pattern";
}

function reportLoss(): void {
  pendingLossReport = null;
  const now = performance.now();
  const lost = [...lostInWindow];
  for (const record of liveContexts.values()) {
    if (!lost.includes(record) && record.gl?.isContextLost() === true) {
      lost.push(record);
    }
  }
  const survivors = [...liveContexts.values()].filter(
    (record) => !lost.includes(record),
  );
  const records = [...lost, ...survivors];
  const trigger = lostInWindow[0];
  const reference = trigger?.lostAt ?? now;

  console.groupCollapsed(
    `[GpuContext] WebGL context lost (${trigger?.owner ?? "unknown"}): ${classifyLoss(lost, survivors)}`,
  );
  console.warn(`statusMessage: ${lossStatusMessage || "(empty)"}`);
  console.warn(`GPU: ${gpuDescription ?? "(unknown)"}`);
  console.warn(
    `visibility: ${document.visibilityState}, JS heap: ${readHeapMegabytes() ?? "(unavailable)"}`,
  );
  console.warn(
    `live contexts: ${records.length} (lost ${lost.length}, alive ${survivors.length})`,
  );
  for (const record of records) {
    const age = ((reference - record.createdAt) / 1000).toFixed(2);
    const state = lost.includes(record) ? "LOST" : "alive";
    console.warn(
      `  #${record.id} ${record.owner} ${record.width}x${record.height} created ${age}s before loss: ${state}`,
    );
  }
  console.warn(
    `recent events (relative to loss):\n${events.map((event) => formatEvent(event, reference)).join("\n")}`,
  );
  console.groupEnd();
  lostInWindow = [];
  lossStatusMessage = "";
}

export function registerGpuContext(
  owner: GpuContextOwner,
  application: Application,
): GpuContextRegistration {
  // Logging must never break renderer setup, so a missing canvas or renderer
  // (test doubles, a half-initialised app) degrades to an unsized record.
  const canvas = application.canvas as Application["canvas"] | undefined;
  const gl = readGl(application);
  describeGpu(gl);
  const record: GpuContextRecord = {
    id: nextContextId++,
    owner,
    width: canvas?.width ?? 0,
    height: canvas?.height ?? 0,
    createdAt: performance.now(),
    gl,
    lostAt: null,
  };
  liveContexts.set(record.id, record);
  const eventBase = {
    id: record.id,
    owner,
    width: record.width,
    height: record.height,
  };
  pushEvent({ ...eventBase, at: record.createdAt, kind: "created", detail: `${liveContexts.size} live` });

  const handleLost = (event: Event) => {
    record.lostAt = performance.now();
    const statusMessage = (event as WebGLContextEvent).statusMessage ?? "";
    pushEvent({ ...eventBase, at: record.lostAt, kind: "lost", detail: statusMessage || undefined });
    lostInWindow.push(record);
    if (pendingLossReport === null) {
      lossStatusMessage = statusMessage;
      pendingLossReport = setTimeout(reportLoss, LOSS_REPORT_DELAY_MS);
    }
  };
  const handleRestored = () => {
    pushEvent({ ...eventBase, at: performance.now(), kind: "restored" });
  };
  canvas?.addEventListener?.("webglcontextlost", handleLost);
  canvas?.addEventListener?.("webglcontextrestored", handleRestored);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas?.removeEventListener?.("webglcontextlost", handleLost);
      canvas?.removeEventListener?.("webglcontextrestored", handleRestored);
      liveContexts.delete(record.id);
      const lifetime = ((performance.now() - record.createdAt) / 1000).toFixed(2);
      pushEvent({ ...eventBase, at: performance.now(), kind: "disposed", detail: `lived ${lifetime}s` });
    },
  };
}

export function recordGpuContextInitFailure(
  owner: GpuContextOwner,
  width: number,
  height: number,
  cause: unknown,
): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  pushEvent({ at: performance.now(), kind: "init-failed", id: null, owner, width, height, detail: message });
  console.warn(
    `[GpuContext] ${owner} ${width}x${height} failed to create a WebGL context with ${liveContexts.size} live:`,
    `\n${events.map((event) => formatEvent(event, performance.now())).join("\n")}`,
  );
}

/** Console handle: `__VLO_GPU_CONTEXTS__()` prints the current state. */
export function getGpuContextDiagnostics() {
  const now = performance.now();
  return {
    gpu: gpuDescription ?? null,
    live: [...liveContexts.values()].map((record) => ({
      id: record.id,
      owner: record.owner,
      size: `${record.width}x${record.height}`,
      ageSeconds: Number(((now - record.createdAt) / 1000).toFixed(2)),
      lost: record.lostAt !== null || record.gl?.isContextLost() === true,
    })),
    events: events.map((event) => formatEvent(event, now)),
  };
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__VLO_GPU_CONTEXTS__ =
    getGpuContextDiagnostics;
}

/** Test-only reset. */
export function resetGpuContextDiagnosticsForTests(): void {
  if (pendingLossReport !== null) clearTimeout(pendingLossReport);
  pendingLossReport = null;
  lostInWindow = [];
  lossStatusMessage = "";
  liveContexts.clear();
  events.length = 0;
  nextContextId = 1;
  gpuDescription = undefined;
}
