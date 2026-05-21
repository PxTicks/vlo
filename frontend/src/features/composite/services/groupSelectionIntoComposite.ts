import type {
  CompositeTimelineClip,
  TimelineSelection,
} from "../../../types/TimelineTypes";
import { selectionToCompositeContent } from "../../timelineSelection";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { bakeCompositeProxy } from "./bakeCompositeProxy";
import { createCompositeTimelineClip } from "../utils/createCompositeClip";

export interface GroupSelectionOptions {
  name?: string;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}

/**
 * Chooses the track the composite clip should occupy: the highest (earliest in
 * track order) track that contains a non-mask clip in the selection, falling
 * back to the first selected clip's track, then the first project track.
 */
function pickTargetTrackId(selection: TimelineSelection): string | null {
  const tracks = selection.tracks ?? useTimelineStore.getState().tracks;
  const occupiedTrackIds = new Set(
    selection.clips
      .filter((clip) => clip.type !== "mask")
      .map((clip) => clip.trackId),
  );
  const ordered = tracks.find((track) => occupiedTrackIds.has(track.id));
  if (ordered) {
    return ordered.id;
  }
  return (
    selection.clips.find((clip) => clip.type !== "mask")?.trackId ??
    tracks[0]?.id ??
    null
  );
}

/**
 * Captures a timeline selection as a Composite clip: normalize the region to
 * local zero, bake its proxy video, then atomically swap the selection's clips
 * for a single composite clip anchored at the selection start.
 *
 * Returns the created clip, or null if the selection had no placeable track.
 */
export async function groupSelectionIntoComposite(
  selection: TimelineSelection,
  options: GroupSelectionOptions = {},
): Promise<CompositeTimelineClip | null> {
  const trackId = pickTargetTrackId(selection);
  if (!trackId) {
    return null;
  }

  const content = selectionToCompositeContent(selection);
  const compositeClipId = `clip_${crypto.randomUUID()}`;
  const { asset, contentHash } = await bakeCompositeProxy(content, {
    signal: options.signal,
    onProgress: options.onProgress,
    compositeClipId,
  });

  const compositeClip = createCompositeTimelineClip({
    id: compositeClipId,
    content,
    trackId,
    start: selection.start,
    proxyAssetId: asset.id,
    proxyContentHash: contentHash,
    name: options.name,
  });

  const sourceClipIds = selection.clips.map((clip) => clip.id);
  const didCommit = useTimelineStore
    .getState()
    .groupClipsIntoComposite(sourceClipIds, compositeClip);

  return didCommit ? compositeClip : null;
}
