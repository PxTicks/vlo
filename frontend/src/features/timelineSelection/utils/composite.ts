import type {
  CompositeContent,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { computeFurthestPresentationEnd } from "../../timeline/utils/clipPresentation";

/**
 * Adapters between a {@link TimelineSelection} (anchored at absolute timeline
 * ticks) and a {@link CompositeContent} (the same region normalized to local
 * zero so it can live inside a portable Composite clip).
 *
 * The whole point of the Composite "prebaked" strategy is that a
 * composite's content renders through the *existing* selection/export pipeline
 * unchanged — so capture shifts the region to zero, and bake/replay shifts a
 * zero-anchored copy straight back into a TimelineSelection.
 */

function cloneClipWithStartShift<T extends TimelineClip>(
  clip: T,
  deltaTicks: number,
): T {
  const cloned = structuredClone(clip);
  if (deltaTicks === 0) {
    return cloned;
  }
  return { ...cloned, start: cloned.start + deltaTicks };
}

function cloneTracks(
  tracks: TimelineTrack[] | undefined,
): TimelineTrack[] | undefined {
  return tracks ? structuredClone(tracks) : undefined;
}

/**
 * Captures a selection as portable composite content: every clip (including
 * subordinate mask clips) is shifted so the window's start lands on tick 0.
 * Clips that began before the window keep a negative start, so only the portion
 * inside the window is visible — exactly as the selection rendered in place.
 */
export function selectionToCompositeContent(
  selection: TimelineSelection,
  fps: number,
): CompositeContent {
  const start = selection.start;
  // Presentation-aware so a slow/fast adjustment inside the selection captures
  // the true rendered length, not the raw stored clip ends.
  const end =
    selection.end ??
    computeFurthestPresentationEnd(
      selection.tracks ?? [],
      selection.clips,
      fps,
    );
  const durationTicks = Math.max(0, end - start);

  return {
    durationTicks,
    clips: selection.clips.map((clip) => cloneClipWithStartShift(clip, -start)),
    ...(selection.tracks ? { tracks: cloneTracks(selection.tracks) } : {}),
    ...(selection.includedTrackIds
      ? { includedTrackIds: selection.includedTrackIds.slice() }
      : {}),
    ...(typeof selection.fps === "number" ? { fps: selection.fps } : {}),
    ...(typeof selection.frameStep === "number"
      ? { frameStep: selection.frameStep }
      : {}),
  };
}

/**
 * Re-namespaces a composite content's track ids so the captured region is
 * self-contained and never collides with the parent timeline (or sibling
 * composites). `selectionToCompositeContent` clones `selection.tracks`
 * verbatim, which are the parent timeline's tracks — so without this, a
 * composite's content carries the exact same track ids as the timeline it was
 * cut from. Anything that indexes clips by `trackId` across the parent and a
 * composite's content then cross-talks (e.g. the engine requesting live frames
 * for a nested content clip because its track id matches a parent track).
 *
 * Only track ids are rewritten: clip ids are already globally-unique uuids, and
 * remapping them would also have to chase mask-clip id conventions, mask_ref /
 * mask_composition references and brush-buffer/asset linkage — none of which is
 * needed to break the track-id collision. `clip.trackId`, `track.id` and
 * `includedTrackIds` are all remapped through the same map so masks stay on
 * their parent's (new) track. Returns content unchanged when it carries no
 * tracks.
 */
export function renamespaceCompositeContentTracks(
  content: CompositeContent,
): CompositeContent {
  if (!content.tracks || content.tracks.length === 0) {
    return content;
  }

  const trackIdMap = new Map<string, string>();
  for (const track of content.tracks) {
    trackIdMap.set(track.id, `track_${crypto.randomUUID()}`);
  }
  const remapTrackId = (trackId: string): string =>
    trackIdMap.get(trackId) ?? trackId;

  return {
    ...content,
    tracks: content.tracks.map((track) => ({
      ...track,
      id: remapTrackId(track.id),
    })),
    clips: content.clips.map((clip) => ({
      ...clip,
      trackId: remapTrackId(clip.trackId),
    })),
    ...(content.includedTrackIds
      ? { includedTrackIds: content.includedTrackIds.map(remapTrackId) }
      : {}),
  };
}

/**
 * Replays composite content as a zero-anchored selection suitable for the bake
 * pipeline (ExportRenderer / renderTimelineSelectionToMp4). The clips are
 * already local-zero, so this is a thin re-wrap; `end` is the natural duration.
 */
export function compositeContentToSelection(
  content: CompositeContent,
): TimelineSelection {
  return {
    start: 0,
    end: content.durationTicks,
    clips: structuredClone(content.clips),
    ...(content.tracks ? { tracks: cloneTracks(content.tracks) } : {}),
    ...(content.includedTrackIds
      ? { includedTrackIds: content.includedTrackIds.slice() }
      : {}),
    ...(typeof content.fps === "number" ? { fps: content.fps } : {}),
    ...(typeof content.frameStep === "number"
      ? { frameStep: content.frameStep }
      : {}),
  };
}

/**
 * Deterministic projection of the bake-affecting fields of a clip. Anything
 * that changes a rendered pixel (timing, transforms, components, asset, text,
 * shape) is included; volatile/UI-only fields (name) are not, so cosmetic edits
 * don't force a re-bake.
 */
function projectClipForHash(clip: TimelineClip): unknown {
  const common = {
    id: clip.id,
    type: clip.type,
    trackId: clip.trackId,
    start: clip.start,
    offset: clip.offset,
    timelineDuration: clip.timelineDuration,
    croppedSourceDuration: clip.croppedSourceDuration,
    sourceDuration: clip.sourceDuration,
    transformedDuration: clip.transformedDuration,
    transformedOffset: clip.transformedOffset,
    transformations: clip.transformations,
  };

  if (clip.type === "mask") {
    // Mask clips carry no components; their full record is part of the matte.
    return { ...common, mask: clip as unknown as Record<string, unknown> };
  }

  return {
    ...common,
    isMuted: clip.isMuted ?? false,
    components: clip.components ?? [],
    // A nested composite is an asset-backed clip; its `assetId` is the nested
    // bake, so re-baking the nested composite already changes this projection.
    ...("assetId" in clip ? { assetId: clip.assetId } : {}),
    ...("compositeId" in clip && clip.compositeId
      ? { compositeId: clip.compositeId }
      : {}),
    ...("textData" in clip ? { textData: clip.textData } : {}),
  };
}

function projectContentForHash(content: CompositeContent): unknown {
  return {
    durationTicks: content.durationTicks,
    fps: content.fps ?? null,
    frameStep: content.frameStep ?? null,
    includedTrackIds: content.includedTrackIds ?? null,
    tracks: (content.tracks ?? []).map((track) => ({
      id: track.id,
      type: track.type ?? null,
      isVisible: track.isVisible,
      isMuted: track.isMuted,
    })),
    clips: content.clips.map(projectClipForHash),
  };
}

/** djb2 string hash → unsigned 32-bit hex. Cheap and stable; collisions only
 *  cost a redundant re-bake, never a missed one for distinct structures. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Hash of the content's bake-affecting structure. Recorded on the baked asset's
 * `creationMetadata.contentHash` as provenance — which content a given bake came
 * from. Rendering does not gate on it: a CompositeAsset's `bakedAssetId` is
 * swapped atomically with its `content`, so the bake is never stale relative to
 * the asset that owns it.
 */
export function hashCompositeContent(content: CompositeContent): string {
  return djb2(JSON.stringify(projectContentForHash(content)));
}
