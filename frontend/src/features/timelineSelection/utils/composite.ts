import type {
  CompositeContent,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { createTimelinePlacementMapper } from "../../timeline";

/**
 * Converters for moving timeline regions between absolute project time and
 * composite-local time.
 */

function cloneTracks(
  tracks: TimelineTrack[] | undefined,
): TimelineTrack[] | undefined {
  return tracks ? structuredClone(tracks) : undefined;
}

/**
 * Captures only the portion of each clip inside the selection as
 * composite-local content. Crop/source offsets are preserved by applying the
 * same resize calculations as an interactive timeline trim.
 */
export function selectionToCompositeContent(
  selection: TimelineSelection,
  fps: number,
  presentationContextClips: readonly TimelineClip[] = selection.clips,
): CompositeContent {
  const start = selection.start;
  const tracks = selection.tracks ?? [];
  const placementMapper = createTimelinePlacementMapper({
    tracks,
    clips: presentationContextClips,
    fps,
  });
  const end =
    selection.end ??
    selection.clips.reduce((furthest, clip) => {
      const footprint = placementMapper.getPresentationFootprint(clip.id);
      return Math.max(furthest, footprint?.end ?? 0);
    }, start);
  const durationTicks = Math.max(0, end - start);
  const projected = placementMapper.projectRegionToLocalTimeline(
    { start, end },
    selection.clips.map((clip) => clip.id),
  );

  return {
    durationTicks,
    clips: projected.clips,
    ...(selection.tracks ? { tracks: cloneTracks(selection.tracks) } : {}),
    ...(selection.transitions
      ? { transitions: structuredClone(selection.transitions) }
      : {}),
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
 * Gives captured tracks fresh ids so composite-local tracks cannot collide with
 * parent or sibling timelines in trackId-keyed render and lookup code. Only
 * track ids are rewritten; clip ids and mask references stay intact.
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

export function compositeContentToSelection(
  content: CompositeContent,
): TimelineSelection {
  return {
    start: 0,
    end: content.durationTicks,
    clips: structuredClone(content.clips),
    ...(content.tracks ? { tracks: cloneTracks(content.tracks) } : {}),
    ...(content.transitions
      ? { transitions: structuredClone(content.transitions) }
      : {}),
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
 * Projects content down to fields that affect baked pixels. Names and other
 * UI-only fields stay out so cosmetic edits do not force a re-bake.
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
    // Include both bake identity and composite identity: dependent rebakes update
    // assetId, while reference/cycle logic follows compositeId.
    ...("assetId" in clip ? { assetId: clip.assetId } : {}),
    ...("compositeId" in clip && clip.compositeId
      ? { compositeId: clip.compositeId }
      : {}),
    ...("textData" in clip ? { textData: clip.textData } : {}),
    ...(clip.type === "extension"
      ? { extensionPayload: clip.extensionPayload }
      : {}),
    ...(clip.type === "adjustment"
      ? {
          depth: clip.depth,
          retimingMode: clip.retimingMode ?? "static",
        }
      : {}),
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
    transitions: content.transitions ?? [],
  };
}

/** Cheap stable string hash; collisions only cost a redundant re-bake. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function hashCompositeContent(content: CompositeContent): string {
  return djb2(JSON.stringify(projectContentForHash(content)));
}
