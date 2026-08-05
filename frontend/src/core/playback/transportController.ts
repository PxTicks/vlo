/**
 * The seam between "something wants the transport moved" and the player that
 * owns transport (extension-remaining-surfaces plan, Phase H / A1).
 *
 * The playhead has one authority — `Player` — because starting playback also
 * starts the audio clock, and pausing settles the playhead on a frame
 * boundary. Callers outside the player feature (the extension API today, a
 * command palette or host command tomorrow) go through this registry rather
 * than writing `playbackClock` directly, so they inherit the player's snapping
 * and arbitration instead of re-deriving it.
 *
 * No controller installed is a legitimate state, not an error: the projects
 * page has no player.
 */
export interface HostTransportController {
  /**
   * False while another flow owns the transport — an export or extraction run,
   * or an armed capture mode. Callers should refuse rather than queue.
   */
  canControl(): boolean;
  /** Starts playback from the playhead. A no-op when already playing. */
  play(): void;
  /** Stops playback, settling the playhead on a frame boundary. */
  pause(): void;
  /** Moves the playhead, clamped and frame-snapped by the player. */
  seek(timeTicks: number): void;
}

let installedController: HostTransportController | null = null;

/**
 * Installs the transport authority. Last writer wins and disposal only clears
 * the controller it installed, so a remount that installs before the old
 * effect cleans up cannot leave the registry empty.
 */
export function installHostTransportController(
  controller: HostTransportController,
): () => void {
  installedController = controller;
  return () => {
    if (installedController === controller) installedController = null;
  };
}

export function getHostTransportController(): HostTransportController | null {
  return installedController;
}
