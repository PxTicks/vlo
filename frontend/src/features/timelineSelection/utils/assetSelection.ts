import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";

/**
 * Resolves a TimelineSelection from an asset's creation metadata.
 * Returns the first timelineSelection found in the asset's inputs,
 * or from extracted metadata.
 */
export function getTimelineSelectionFromAsset(
  asset: Asset,
): TimelineSelection | null {
  const meta = asset.creationMetadata;
  if (!meta) return null;

  if (meta.source === "extracted" && meta.timelineSelection) {
    return meta.timelineSelection;
  }

  if (meta.source === "generated") {
    for (const input of meta.inputs) {
      if (input.kind === "timelineSelection" && input.timelineSelection) {
        return input.timelineSelection;
      }
    }
  }

  return null;
}
