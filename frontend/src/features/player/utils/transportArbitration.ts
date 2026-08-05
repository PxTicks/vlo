import { useExtractStore } from "../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";

/**
 * The states in which a *programmatic* transport write is refused
 * (extension-remaining-surfaces plan, Phase H / A1). Kept as a pure function
 * over an explicit snapshot so the rule is testable without a mounted player.
 */
export interface TransportArbitrationState {
  /** An export or extraction run is producing frames. */
  readonly extracting: boolean;
  /** The user is picking a frame to extract. */
  readonly frameSelectionMode: boolean;
  /** The user is picking a timeline range to extract. */
  readonly timelineSelectionMode: boolean;
}

/**
 * Each of these means a capture flow is depending on where the playhead is:
 * an extraction run is producing frames behind a modal dialog, and the two
 * selection modes are armed and waiting for the user to confirm what to
 * extract.
 *
 * This is intentionally stricter than the host's own controls, which stay
 * live: the play button is never disabled, and the ruler keeps scrubbing.
 * That asymmetry is the point — a user who armed a capture mode can see it in
 * the UI and move the playhead knowingly, while an extension acting in the
 * background would change what gets captured with nothing to warn anyone. The
 * host does already withdraw the affordances it can attribute to the same
 * intent (timeline click-to-seek and the canvas menu's play item), so this
 * extends that reasoning rather than inventing it.
 */
export function isTransportAvailable(state: TransportArbitrationState): boolean {
  return (
    !state.extracting &&
    !state.frameSelectionMode &&
    !state.timelineSelectionMode
  );
}

export function readTransportArbitrationState(): TransportArbitrationState {
  const extract = useExtractStore.getState();
  return {
    extracting: extract.isProcessing,
    frameSelectionMode: extract.frameSelectionMode,
    timelineSelectionMode:
      useTimelineSelectionStore.getState().selectionMode,
  };
}
