/**
 * The seam between "something wants a render started" and the export job
 * controller that owns rendering (extension-remaining-surfaces plan, Phase I /
 * D2). The transport equivalent is `core/playback/transportController`, and
 * the reasoning is the same: a render acquires a GPU context, a decoder pool,
 * a wake lock, and the progress UI, so it has one authority — the mounted
 * editor — and callers outside it state intent here rather than assembling an
 * `ExportRenderer` of their own.
 *
 * No controller installed is a legitimate state, not an error: the projects
 * page has no renderer mounted.
 */
export interface HostExportRunRequest {
  /** Rendered range, in canonical ticks. Already validated by the caller. */
  readonly startTicks: number;
  readonly endTicks: number;
  /** Catalogue option ID from `export.formats`, recorded on the run. */
  readonly formatId: string;
  /**
   * Output container. An open string here on purpose: the encoder's format
   * union belongs to the renderer feature, and the installer — which owns the
   * encoder — is what narrows and validates it.
   */
  readonly format: string;
  /** Seconds between keyframes, when the format asks for one. */
  readonly keyFrameInterval?: number;
  /** Render frame rate; the project's own rate when omitted. */
  readonly fps?: number | null;
  /** Renders every Nth frame. 1 renders them all. */
  readonly frameStep?: number;
  /** Restricts the render to these tracks; all tracks when omitted. */
  readonly trackIds?: readonly string[];
  /** Attribution for the run record. */
  readonly startedByExtension?: string;
}

export interface HostExportController {
  /**
   * False while the renderer is already busy — an export, an extraction, or a
   * frame capture. Callers should refuse rather than queue: renders are
   * exclusive, and nothing here waits.
   */
  canStart(): boolean;
  /**
   * Starts a range render and returns its run ID immediately. The run itself
   * reports progress and its outcome through `exportRunLog`, so the caller
   * observes it the same way an observer that did not start it does.
   */
  startRange(request: HostExportRunRequest): string;
  /** Cancels the run in flight, if any. */
  cancel(): void;
}

let installedController: HostExportController | null = null;

/**
 * Installs the render authority. Last writer wins and disposal only clears the
 * controller it installed, so a remount that installs before the old effect
 * cleans up cannot leave the registry empty.
 */
export function installHostExportController(
  controller: HostExportController,
): () => void {
  installedController = controller;
  return () => {
    if (installedController === controller) installedController = null;
  };
}

export function getHostExportController(): HostExportController | null {
  return installedController;
}
