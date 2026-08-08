import type {
  ExtensionExportFrameResult,
  ExtensionModule,
  ExtensionTaskHandle,
  VloExtensionApi,
} from "@vlo/extension-sdk";

/** The provider this package declares in its manifest `dependencies`. */
export const FALSE_COLOR_EXTENSION_ID = "example.false-color";

/** Local name; the host publishes it as `extension.example.exposure-report.scanned`. */
export const SCANNED_CONTEXT_KEY = "scanned";

/**
 * The half of the provider's exported API this package actually uses. Narrowing
 * it here rather than importing the provider's source is the point: the two
 * packages ship separately, and the contract between them is this shape.
 */
interface FalseColorPeerApi {
  readonly apiVersion: number;
  classifyLuma(luma: number): { readonly name: string };
}

export interface ExposureReportRow {
  readonly timeTicks: number;
  readonly zone: string;
}

interface ReportState {
  peerApiVersion: number | null;
  rows: ExposureReportRow[];
  lastTaskMessage: string | null;
  cancelled: boolean;
}

const reportState: ReportState = {
  peerApiVersion: null,
  rows: [],
  lastTaskMessage: null,
  cancelled: false,
};

/** Test-only accessor; not part of any host contract. */
export function getExposureReportStateForConformance(): Readonly<ReportState> {
  return reportState;
}

export function resetExposureReportStateForConformance(): void {
  reportState.peerApiVersion = null;
  reportState.rows = [];
  reportState.lastTaskMessage = null;
  reportState.cancelled = false;
}

function isFalseColorApi(value: unknown): value is FalseColorPeerApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "apiVersion" in value &&
    typeof (value as { classifyLuma?: unknown }).classifyLuma === "function"
  );
}

/**
 * Mean luma of one *decoded* frame.
 *
 * Unlike a scope's sampled frame, these bytes carry straight alpha: the host
 * composites premultiplied, but `getImageData` un-premultiplies on the way out,
 * so dividing by alpha again here would blow out every semi-transparent pixel.
 */
export function averageLuma(pixels: Uint8ClampedArray): number {
  let total = 0;
  let counted = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const r = pixels[offset] / 255;
    const g = pixels[offset + 1] / 255;
    const b = pixels[offset + 2] / 255;
    total += r * 0.2126 + g * 0.7152 + b * 0.0722;
    counted += 1;
  }
  return counted === 0 ? 0 : total / counted;
}

/** Turns one encoded frame into straight-alpha RGBA, or null if it cannot. */
export type FrameDecoder = (blob: Blob) => Promise<Uint8ClampedArray | null>;

/**
 * `renderFrame` answers with an *encoded* image — a PNG or WebP blob, not raw
 * pixels — so anything that wants to measure the picture has to decode it
 * first. `createImageBitmap` plus a 2D canvas is the browser-native way to do
 * that; the canvas is never attached, so this works from a background scan.
 *
 * Returns null rather than throwing, because a frame that will not decode is
 * one clip missing from a report, not a reason to abandon the scan.
 */
export const decodeFrameRgba: FrameDecoder = async (blob) => {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  } finally {
    // Bitmaps hold decoded pixels off-heap; a scan over a long timeline that
    // leaked one per clip would be a real problem.
    bitmap?.close();
  }
};

async function readFrameLuma(
  result: ExtensionExportFrameResult,
  decode: FrameDecoder,
): Promise<number | null> {
  if (!result.ok) return null;
  const pixels = await decode(result.blob);
  return pixels === null ? null : averageLuma(pixels);
}

/**
 * Walks the clip starts, renders each one, and classifies it with the
 * provider's vocabulary. Progress goes to the shell notification centre because
 * this is minutes of work with nothing else on screen.
 */
export async function runScan(
  api: VloExtensionApi,
  peer: FalseColorPeerApi,
  task: ExtensionTaskHandle,
  isCancelled: () => boolean,
  decode: FrameDecoder = decodeFrameRgba,
): Promise<ExposureReportRow[]> {
  const clips = api.timeline
    .listClips()
    .filter((clip) => clip.type !== "mask")
    .sort((left, right) => left.startTicks - right.startTicks);
  const rows: ExposureReportRow[] = [];
  for (const [index, clip] of clips.entries()) {
    if (isCancelled()) break;
    task.update({
      message: `Scanning ${index + 1} of ${clips.length}`,
      progress: clips.length === 0 ? 1 : index / clips.length,
    });
    const frame = await api.export.renderFrame(clip.startTicks);
    const luma = await readFrameLuma(frame, decode);
    // A refused render is the editor's answer, not an error: the renderer is
    // exclusive, so `export_busy` here means the user started their own. A
    // frame that will not decode drops out the same way.
    if (luma === null) continue;
    rows.push({ timeTicks: clip.startTicks, zone: peer.classifyLuma(luma).name });
  }
  return rows;
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { api } = context;
  // A hard dependency: the host has already activated the provider by the time
  // this runs, so an unavailable API is a genuine failure, not a race.
  const peer = api.extensions.requireApi(FALSE_COLOR_EXTENSION_ID);
  if (!isFalseColorApi(peer)) {
    throw new Error("The false-colour extension exported an unexpected API.");
  }
  reportState.peerApiVersion = peer.apiVersion;

  api.ui.commands.register({
    id: "scan-exposure",
    apiVersion: 1,
    title: "Scan clip exposure",
    when: { key: "project.open" },
    run: async () => {
      reportState.cancelled = false;
      const task = api.ui.notifications.task({
        title: "Exposure report",
        message: "Starting",
        progress: 0,
        onCancel: () => {
          reportState.cancelled = true;
        },
      });
      try {
        reportState.rows = await runScan(
          api,
          peer,
          task,
          () => reportState.cancelled,
        );
        // Namespaced: another package can gate its own command on
        // `extension.example.exposure-report.scanned` without either of us
        // reaching into the timeline model.
        api.ui.commands.setContextKey(SCANNED_CONTEXT_KEY, reportState.rows.length);
        reportState.lastTaskMessage = reportState.cancelled
          ? "Exposure scan cancelled"
          : `Classified ${reportState.rows.length} clips`;
        task.settle({
          message: reportState.lastTaskMessage,
          tone: reportState.cancelled ? "warning" : "success",
        });
      } catch (error) {
        reportState.lastTaskMessage = "Exposure scan failed";
        task.settle({ message: reportState.lastTaskMessage, tone: "error" });
        throw error;
      }
    },
  });

  api.ui.registerView({
    id: "report",
    apiVersion: 1,
    kind: "trusted-view",
    title: "Exposure",
    defaultRegion: "bottom-dock",
    // Only meaningful once a scan has published its key — which is this
    // package reading back its own contributed context key.
    when: { key: `extension.${context.extension.id}.${SCANNED_CONTEXT_KEY}` },
    component: () => null,
  });

  context.logger.info("exposure report activated", {
    peerApiVersion: peer.apiVersion,
  });
};
