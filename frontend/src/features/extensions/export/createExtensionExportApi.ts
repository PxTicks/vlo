import { useExtractStore } from "../../../core/extract/useExtractStore";
import { getHostExportController } from "../../../core/export/exportController";
import {
  getActiveExportRun,
  getExportRunRevision,
  getLatestExportRun,
  listExportRuns,
  subscribeExportRuns,
  type ExportRunRecord,
} from "../../../core/export/exportRunLog";
import { hostOptionCatalog } from "../../../core/shell/optionCatalog";
import {
  combineRevisionSources,
  createRevisionRelay,
  type RevisionSource,
} from "../../../core/shell/revisionRelay";
import { snapTickToFrameGrid } from "../../../core/time/frameGrid";
import {
  DEFAULT_EXPORT_FORMAT_ID,
  EXPORT_FORMATS_CATALOGUE,
  readExportFormatValue,
} from "../../player/exportFormatsCatalogue";
import { useProjectStore } from "../../project";
import { renderProjectFrameAtTick } from "../../renderer";
import { getTimelineDuration } from "../../timeline/api";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import type {
  ExtensionApiScope,
  ExtensionExportApi,
  ExtensionExportCancelFailureCode,
  ExtensionExportCancelResult,
  ExtensionExportFailureCode,
  ExtensionExportFrameRequest,
  ExtensionExportFrameResult,
  ExtensionExportRunSnapshot,
  ExtensionExportStartRequest,
  ExtensionExportStartResult,
} from "../types";

const exportRunSignal: RevisionSource = Object.freeze({
  subscribe: subscribeExportRuns,
  getRevision: getExportRunRevision,
});

/**
 * Whether the renderer is busy is not derivable from the run log alone: a
 * host export keeps its dialog — and with it `isProcessing` — up for a moment
 * after the run settles, and the host's frame capture is never a run at all.
 * Folding availability into the same signal is what stops "completed" being
 * the last thing an extension hears before a `start()` that is refused: when
 * the editor actually frees up, the domain signals again.
 */
const rendererAvailabilitySignal = createRevisionRelay(
  useExtractStore,
  (state) => [state.isProcessing],
);

const exportSignal = combineRevisionSources(
  exportRunSignal,
  rendererAvailabilitySignal,
);

function toSnapshot(record: ExportRunRecord): ExtensionExportRunSnapshot {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    status: record.status,
    startTicks: record.startTicks,
    endTicks: record.endTicks,
    formatId: record.formatId,
    progress: record.progress,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    startedByExtension: record.startedByExtension,
    assetId: record.assetId,
    error: record.error,
  });
}

function failure(
  code: ExtensionExportFailureCode,
  message: string,
): { readonly ok: false; readonly code: ExtensionExportFailureCode; readonly message: string } {
  return Object.freeze({ ok: false as const, code, message });
}

function cancelFailure(
  code: ExtensionExportCancelFailureCode,
  message: string,
): ExtensionExportCancelResult {
  return Object.freeze({ ok: false as const, code, message });
}

/**
 * A project is open only when the record and its directory handle are both
 * present, matching `api.project` and the `project.open` context key. Without
 * one there is no timeline to composite.
 */
function hasOpenProject(): boolean {
  const state = useProjectStore.getState();
  return Boolean(state.project && state.rootHandle);
}

/**
 * Frame renders are not runs — they are request/response, and settle in
 * seconds — so nothing else tracks one in flight. Module-scoped rather than
 * per-extension because the exclusivity is the renderer's, not an owner's:
 * two extensions each compositing a frame would contend for the same decoders.
 */
let frameRenderInFlight = false;

/**
 * The renderer is exclusive. The run log covers renders started anywhere,
 * `isProcessing` covers the dialog-driven flows that have not reached the
 * renderer yet plus the host's own frame capture, and the frame-render flag
 * covers the one path with no host-side trace.
 */
function isRendererBusy(): boolean {
  return (
    getActiveExportRun() !== null ||
    frameRenderInFlight ||
    useExtractStore.getState().isProcessing
  );
}

function assertFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

/**
 * Owner-bound `api.export` (extension-remaining-surfaces plan, Phase I / D2):
 * observe the editor's renders, read a composited frame, and ask for a render.
 *
 * Every write goes through the installed host export controller rather than
 * assembling an `ExportRenderer` here, for the same reason transport writes go
 * through the player: a render acquires a GPU context, a decoder pool, a wake
 * lock, and the progress UI, and an extension that bypassed that would reach a
 * state the editor cannot show or cancel.
 */
export function createExtensionExportApi(
  scope: ExtensionApiScope,
): ExtensionExportApi {
  const ownerId = scope.extension.id;

  return Object.freeze({
    getRun: () => {
      const record = getLatestExportRun();
      return record === null ? null : toSnapshot(record);
    },
    listRuns: () => Object.freeze(listExportRuns().map(toSnapshot)),
    subscribe: bindOwnerScopedSubscribe(scope, exportSignal, "Export"),
    getRevision: () => exportSignal.getRevision(),

    renderFrame: async (
      timeTicks: number,
      request: ExtensionExportFrameRequest = {},
    ): Promise<ExtensionExportFrameResult> => {
      assertFiniteNumber(timeTicks, "Frame time");
      if (!hasOpenProject()) {
        return failure("no_project", "No project is open, so there is nothing to render.");
      }
      if (isRendererBusy()) {
        return failure(
          "export_busy",
          "A render is already in flight; the renderer cannot composite a frame at the same time.",
        );
      }

      // Snapped up front rather than deep in the renderer so the result can
      // report the tick that was actually composited. Clamped at zero only —
      // past the end of the timeline there is a real, empty frame to render,
      // and silently pulling the request back to the last clip would answer a
      // question the caller did not ask.
      const snappedTick = snapTickToFrameGrid(
        Math.max(0, timeTicks),
        useProjectStore.getState().config.fps,
      );

      frameRenderInFlight = true;
      try {
        const frame = await renderProjectFrameAtTick(snappedTick, {
          ...(request.mimeType ? { mimeType: request.mimeType } : {}),
          ...(request.quality !== undefined ? { quality: request.quality } : {}),
        });
        return Object.freeze({
          ok: true as const,
          blob: frame.blob,
          width: frame.width,
          height: frame.height,
          timeTicks: snappedTick,
        });
      } catch (error) {
        scope.report("warning", "Frame render failed.", error);
        return failure(
          "render_failed",
          error instanceof Error ? error.message : "The renderer produced no frame.",
        );
      } finally {
        frameRenderInFlight = false;
      }
    },

    start: (
      request: ExtensionExportStartRequest = {},
    ): ExtensionExportStartResult => {
      if (typeof request !== "object" || request === null) {
        throw new TypeError("Export request must be an object.");
      }
      if (request.startTicks !== undefined) {
        assertFiniteNumber(request.startTicks, "Export start");
      }
      if (request.endTicks !== undefined) {
        assertFiniteNumber(request.endTicks, "Export end");
      }
      if (request.fps !== undefined) assertFiniteNumber(request.fps, "Export fps");
      if (request.frameStep !== undefined) {
        assertFiniteNumber(request.frameStep, "Export frame step");
      }
      if (request.trackIds !== undefined && !Array.isArray(request.trackIds)) {
        throw new TypeError("Export track IDs must be an array.");
      }

      if (!hasOpenProject()) {
        return failure("no_project", "No project is open, so there is nothing to render.");
      }

      const controller = getHostExportController();
      if (controller === null) {
        return failure(
          "no_renderer",
          "No renderer is mounted, so a render cannot be started.",
        );
      }
      if (!controller.canStart() || isRendererBusy()) {
        return failure(
          "export_busy",
          "A render is already in flight. Renders are exclusive and are not queued.",
        );
      }

      const formatId = request.formatId ?? DEFAULT_EXPORT_FORMAT_ID;
      const format = readExportFormatValue(
        hostOptionCatalog.getOption(EXPORT_FORMATS_CATALOGUE, formatId),
      );
      if (format === null) {
        return failure(
          "unknown_format",
          `'${formatId}' is not an option in the '${EXPORT_FORMATS_CATALOGUE}' catalogue.`,
        );
      }

      const duration = getTimelineDuration();
      const startTicks = request.startTicks ?? 0;
      const endTicks = request.endTicks ?? duration;
      if (startTicks < 0 || endTicks <= startTicks || endTicks > duration) {
        return failure(
          "invalid_range",
          `Range ${startTicks}–${endTicks} does not fall inside the timeline (0–${duration}).`,
        );
      }

      const runId = controller.startRange({
        startTicks,
        endTicks,
        formatId,
        format: format.format,
        ...(format.keyFrameInterval !== undefined
          ? { keyFrameInterval: format.keyFrameInterval }
          : {}),
        ...(request.fps !== undefined ? { fps: request.fps } : {}),
        ...(request.frameStep !== undefined
          ? { frameStep: request.frameStep }
          : {}),
        ...(request.trackIds ? { trackIds: [...request.trackIds] } : {}),
        startedByExtension: ownerId,
      });

      const record = listExportRuns().find((entry) => entry.id === runId);
      if (record === undefined) {
        return failure(
          "render_failed",
          "The renderer accepted the request but did not record a run.",
        );
      }
      return Object.freeze({ ok: true as const, run: toSnapshot(record) });
    },

    cancel: (runId: string): ExtensionExportCancelResult => {
      if (typeof runId !== "string" || runId.length === 0) {
        throw new TypeError("Run ID must be a non-empty string.");
      }
      const record = listExportRuns().find((entry) => entry.id === runId);
      if (record === undefined) {
        return cancelFailure("run_not_found", `No run '${runId}' in this session.`);
      }
      if (record.startedByExtension !== ownerId) {
        return cancelFailure(
          "run_not_owned",
          "That render was started elsewhere; only the host dialog can cancel it.",
        );
      }
      if (record.status !== "running") {
        return Object.freeze({ ok: true as const, changed: false });
      }

      const controller = getHostExportController();
      if (controller === null) {
        return cancelFailure(
          "no_renderer",
          "No renderer is mounted, so there is nothing to cancel.",
        );
      }
      controller.cancel();
      // The renderer aborts asynchronously, so `changed` reports that a cancel
      // was issued against a live run — the run settles a moment later, which
      // is what `subscribe` is for.
      return Object.freeze({ ok: true as const, changed: true });
    },
  });
}
