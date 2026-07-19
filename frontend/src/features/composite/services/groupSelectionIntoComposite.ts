import type {
  TimelineSelection,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import {
  renamespaceCompositeContentTracks,
  selectionToCompositeContent,
} from "../../timelineSelection";
import {
  getTimelineTracks,
  getTimelineClips,
  getTimelineClipsInPresentationRange,
  getTimelineTransitions,
  groupTimelineClipsIntoComposite,
} from "../../timeline/api";
import { useProjectStore } from "../../project/useProjectStore";
import { createCompositeTimelineClipFromAsset } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";

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
  const tracks = selection.tracks ?? getTimelineTracks();
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
 * local zero, commit its canonical asset, then atomically swap the selection's
 * clips for a single live-renderable composite clip anchored at the selection
 * start. Cache baking continues independently after this function returns.
 *
 * Returns the created clip, or null if the selection had no placeable track.
 */
export async function groupSelectionIntoComposite(
  selection: TimelineSelection,
  options: GroupSelectionOptions = {},
): Promise<VideoTimelineClip | null> {
  const presentationContextClips = getTimelineClips();
  const selectedClips = getTimelineClipsInPresentationRange(
    selection.start,
    selection.end,
  );
  const selectedClipIds = new Set(selectedClips.map((clip) => clip.id));
  const transitions = getTimelineTransitions().filter(
    (transition) =>
      selectedClipIds.has(transition.outgoingClipId) &&
      selectedClipIds.has(transition.incomingClipId),
  );
  const capturedSelection: TimelineSelection = {
    ...selection,
    clips: selectedClips,
    ...(transitions.length > 0 ? { transitions } : {}),
  };
  if (transitions.length === 0) {
    delete capturedSelection.transitions;
  }
  const trackId = pickTargetTrackId(capturedSelection);
  if (!trackId) {
    return null;
  }

  // Re-namespace the captured tracks so the composite's content never shares
  // track ids with the parent timeline it was cut from. selectionToCompositeContent
  // clones the parent's tracks verbatim, which would otherwise leave the content
  // colliding with the live timeline and cause cross-talk in any trackId-keyed
  // lookup.
  const content = renamespaceCompositeContentTracks(
    selectionToCompositeContent(
      capturedSelection,
      useProjectStore.getState().config.fps,
      presentationContextClips,
    ),
  );
  const compositeAsset = await useCompositeLibraryStore
    .getState()
    .createCompositeAsset({
      name: options.name,
      content,
      signal: options.signal,
      onProgress: options.onProgress,
    });

  const compositeClip = createCompositeTimelineClipFromAsset(compositeAsset, {
    trackId,
    start: selection.start,
  });

  const sourceClipIds = capturedSelection.clips.map((clip) => clip.id);
  const didCommit = groupTimelineClipsIntoComposite(
    sourceClipIds,
    compositeClip,
    selection.end === undefined
      ? undefined
      : { start: selection.start, end: selection.end },
  );

  if (!didCommit) {
    await useCompositeLibraryStore
      .getState()
      .deleteCompositeAsset(compositeAsset.id);
  }

  return didCommit ? compositeClip : null;
}
