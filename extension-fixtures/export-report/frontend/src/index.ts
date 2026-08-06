import type {
  ExtensionExportFrameResult,
  ExtensionExportRunKind,
  ExtensionExportRunSnapshot,
  ExtensionExportRunStatus,
  ExtensionExportStartResult,
  ExtensionModule,
} from "@vlo/extension-sdk";

/** Where the fixture parks its report, inside the project. */
export const EXPORT_REPORT_STORAGE_KEY = "export-report";

/** One settled render, as this fixture chooses to remember it. */
export interface ExportReportEntry {
  readonly runId: string;
  readonly kind: ExtensionExportRunKind;
  readonly status: ExtensionExportRunStatus;
  /** Whether this fixture started it, rather than the user or a neighbour. */
  readonly ours: boolean;
  readonly durationMs: number | null;
  readonly assetId: string | null;
  readonly error: string | null;
}

interface ReportState {
  entries: ExportReportEntry[];
  lastStart: ExtensionExportStartResult | null;
  lastFrame: ExtensionExportFrameResult | null;
  thumbnailAssetId: string | null;
}

const reportState: ReportState = {
  entries: [],
  lastStart: null,
  lastFrame: null,
  thumbnailAssetId: null,
};

/** Test-only accessor; not part of any host contract. */
export function getExportReportForConformance(): Readonly<ReportState> {
  return reportState;
}

export function resetExportReportForConformance(): void {
  reportState.entries = [];
  reportState.lastStart = null;
  reportState.lastFrame = null;
  reportState.thumbnailAssetId = null;
}

function isSettled(run: ExtensionExportRunSnapshot): boolean {
  return run.status !== "running";
}

/**
 * The end of the last placed clip, or null when nothing is placed. Mask clips
 * are excluded: they hang off a parent clip rather than occupying timeline
 * time, so they cannot extend the rendered range.
 */
export function lastPlacedTick(
  clips: readonly { type: string; startTicks: number; durationTicks: number }[],
): number | null {
  let end = 0;
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    end = Math.max(end, clip.startTicks + clip.durationTicks);
  }
  return end > 0 ? end : null;
}

export function toReportEntry(
  run: ExtensionExportRunSnapshot,
  ownerId: string,
): ExportReportEntry {
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    ours: run.startedByExtension === ownerId,
    durationMs: run.endedAt === null ? null : run.endedAt - run.startedAt,
    assetId: run.assetId,
    error: run.error,
  };
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { assets, export: exports, playback, storage, timeline } = context.api;
  const { commands } = context.api.ui;
  const ownerId = context.extension.id;

  /**
   * A run is recorded once, when it settles. The signal is progress-grained —
   * it fires repeatedly through a render — so a listener that appended on
   * every notification would produce one entry per frame.
   */
  const recordSettledRuns = () => {
    const run = exports.getRun();
    if (run === null || !isSettled(run)) return;
    if (reportState.entries.some((entry) => entry.runId === run.id)) return;

    reportState.entries = [...reportState.entries, toReportEntry(run, ownerId)];

    // Re-read `storage.project` inside the listener: the project may have
    // closed, or its document may only just have hydrated.
    const projectStorage = storage.project;
    if (!projectStorage) return;
    void projectStorage.set(
      EXPORT_REPORT_STORAGE_KEY,
      reportState.entries.map((entry) => ({ ...entry })),
    );
  };

  recordSettledRuns();
  context.onDispose(exports.subscribe(recordSettledRuns));

  commands.register({
    id: "render-placed-range",
    apiVersion: 1,
    title: "Render everything that is placed, to a new asset",
    when: { key: "project.open" },
    run: () => {
      const end = lastPlacedTick(timeline.listClips());
      if (end === null) return;
      // The result says a run *began*; how it ends arrives through the
      // subscription above, because a render takes minutes.
      reportState.lastStart = exports.start({ startTicks: 0, endTicks: end });
    },
  });

  commands.register({
    id: "capture-thumbnail",
    apiVersion: 1,
    title: "Capture the current frame as an asset",
    when: { key: "project.open" },
    run: async () => {
      const frame = await exports.renderFrame(playback.getTime(), {
        mimeType: "image/png",
      });
      reportState.lastFrame = frame;
      if (!frame.ok) return;

      const asset = await assets.ingest({
        name: `thumbnail-${frame.timeTicks}.png`,
        type: "image",
        blob: frame.blob,
      });
      reportState.thumbnailAssetId = asset.id;
    },
  });

  context.logger.info("export report fixture activated", {
    knownRuns: exports.listRuns().length,
  });
};
