/**
 * The record of what the renderer has been asked to produce
 * (extension-remaining-surfaces plan, Phase I / D2).
 *
 * A render leaves almost no trace: `useExtractStore` carries a progress number
 * and a dialog view while a job is in flight, then resets, so "did the export
 * finish, and what did it produce" is unanswerable a second later. This module
 * is the durable half — one record per render, with the outcome kept after the
 * run ends — and it is what `api.export` reads.
 *
 * Deliberately not a queue. Renders are exclusive (one GPU, one decoder pool),
 * so a start while a run is active is refused by the caller rather than
 * enqueued; there is no `queued` status to observe because nothing ever waits.
 */

/** What the run is rendering. */
export type ExportRunKind =
  /** The whole timeline, written to a file the user picked. */
  | "project"
  /** A tick range, landing in the asset library. */
  | "range";

export type ExportRunStatus =
  | "running"
  | "completed"
  /** The renderer aborted — user cancel, or the caller's own abort. */
  | "cancelled"
  | "failed";

export interface ExportRunRecord {
  readonly id: string;
  readonly kind: ExportRunKind;
  readonly status: ExportRunStatus;
  /** Rendered range, in canonical ticks. */
  readonly startTicks: number;
  readonly endTicks: number;
  /** Catalogue option ID from `export.formats`, or null for a host default. */
  readonly formatId: string | null;
  /** Normalised 0–1, not the renderer's 0–100 percentage. */
  readonly progress: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Extension ID when an extension started it; null for a user-driven run. */
  readonly startedByExtension: string | null;
  /** Output asset, for runs that land in the library. */
  readonly assetId: string | null;
  readonly error: string | null;
}

/**
 * How many finished runs stay readable. An editing session produces a handful
 * of exports, and the log exists so an observer can report on them — not so it
 * can be an audit trail, which would belong in project storage.
 */
export const EXPORT_RUN_HISTORY_LIMIT = 20;

export interface ExportRunHandle {
  readonly id: string;
  /** Accepts the renderer's 0–100 percentage; clamped and normalised here. */
  reportProgress(percentage: number): void;
  complete(outcome?: { assetId?: string | null }): void;
  cancel(): void;
  fail(error: unknown): void;
}

export interface BeginExportRunInput {
  readonly kind: ExportRunKind;
  readonly startTicks: number;
  readonly endTicks: number;
  readonly formatId?: string | null;
  readonly startedByExtension?: string | null;
}

let nextRunId = 1;
let runs: ExportRunRecord[] = [];
let revision = 0;
const listeners = new Set<() => void>();

function notify(): void {
  revision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("Export run listener failed", error);
    }
  }
}

function replaceRun(
  id: string,
  update: (record: ExportRunRecord) => ExportRunRecord,
): void {
  const index = runs.findIndex((record) => record.id === id);
  if (index === -1) return;
  const current = runs[index]!;
  const next = update(current);
  if (next === current) return;
  runs = [...runs.slice(0, index), next, ...runs.slice(index + 1)];
  notify();
}

/** Terminal states are final: a late progress callback must not revive a run. */
function isSettled(record: ExportRunRecord): boolean {
  return record.status !== "running";
}

function settle(
  id: string,
  status: Exclude<ExportRunStatus, "running">,
  patch: Partial<Pick<ExportRunRecord, "assetId" | "error" | "progress">> = {},
): void {
  replaceRun(id, (record) =>
    isSettled(record)
      ? record
      : Object.freeze({
          ...record,
          ...patch,
          status,
          endedAt: Date.now(),
        }),
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Render failed.";
}

export function beginExportRun(input: BeginExportRunInput): ExportRunHandle {
  const id = `export-run-${nextRunId++}`;
  const record: ExportRunRecord = Object.freeze({
    id,
    kind: input.kind,
    status: "running",
    startTicks: input.startTicks,
    endTicks: input.endTicks,
    formatId: input.formatId ?? null,
    progress: 0,
    startedAt: Date.now(),
    endedAt: null,
    startedByExtension: input.startedByExtension ?? null,
    assetId: null,
    error: null,
  });

  // Newest first, so readers never have to sort and trimming is a slice.
  runs = [record, ...runs].slice(0, EXPORT_RUN_HISTORY_LIMIT);
  notify();

  return Object.freeze({
    id,
    reportProgress: (percentage: number) => {
      if (!Number.isFinite(percentage)) return;
      const progress = Math.min(1, Math.max(0, percentage / 100));
      replaceRun(id, (current) =>
        isSettled(current) || current.progress === progress
          ? current
          : Object.freeze({ ...current, progress }),
      );
    },
    complete: (outcome?: { assetId?: string | null }) =>
      settle(id, "completed", {
        progress: 1,
        assetId: outcome?.assetId ?? null,
      }),
    cancel: () => settle(id, "cancelled"),
    fail: (error: unknown) => settle(id, "failed", { error: describeError(error) }),
  });
}

/** The run currently producing frames, or null when the renderer is idle. */
export function getActiveExportRun(): ExportRunRecord | null {
  return runs.find((record) => record.status === "running") ?? null;
}

/** The active run, or the most recent one to finish. */
export function getLatestExportRun(): ExportRunRecord | null {
  return runs[0] ?? null;
}

/** Newest first, capped at {@link EXPORT_RUN_HISTORY_LIMIT}. */
export function listExportRuns(): readonly ExportRunRecord[] {
  return runs;
}

export function subscribeExportRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getExportRunRevision(): number {
  return revision;
}

/** Test seam: drops the log so run IDs and history do not leak between cases. */
export function resetExportRunLogForTests(): void {
  runs = [];
  nextRunId = 1;
  revision = 0;
}
