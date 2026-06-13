import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { getTimelineClips } from "../../timeline/api";
import { normalizeTimelineSelection } from "./timelineSelection";

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
  const timelineClips = getTimelineClips();

  if (meta.source === "extracted" && meta.timelineSelection) {
    return normalizeTimelineSelection(meta.timelineSelection, timelineClips);
  }

  if (meta.source === "generated") {
    for (const input of meta.inputs) {
      if (input.kind === "timelineSelection" && input.timelineSelection) {
        return normalizeTimelineSelection(input.timelineSelection, timelineClips);
      }
    }
  }

  return null;
}
