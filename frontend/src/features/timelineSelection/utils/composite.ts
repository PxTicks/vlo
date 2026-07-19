import type {
  CompositeContent,
  MaskTimelineClip,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  computeFurthestPresentationEnd,
  resolveStoredStartForPresentationStart,
  type TimelineClipPresentation,
} from "../../timeline/utils/clipPresentation";
import { cropTimelineClipToOffsets } from "./clipRange";

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
  // Presentation-aware so a slow/fast adjustment inside the selection captures
  // the true rendered length, not the raw stored clip ends.
  const end =
    selection.end ??
    computeFurthestPresentationEnd(
      selection.tracks ?? [],
      presentationContextClips,
      fps,
      selection.clips,
    );
  const durationTicks = Math.max(0, end - start);
  const tracks = selection.tracks ?? [];
  const contextById = new Map(
    presentationContextClips.map((clip) => [clip.id, clip] as const),
  );
  const presentationById = buildTimelineClipPresentationIndex(
    tracks,
    presentationContextClips,
    fps,
  );
  const targetPresentationStartById = new Map<string, number>();

  const resolvePresentation = (
    clip: TimelineClip,
  ): TimelineClipPresentation | undefined => {
    if (clip.type !== "mask") {
      return presentationById.get(clip.id);
    }
    const parentId = (clip as MaskTimelineClip).parentClipId;
    const parent = parentId ? contextById.get(parentId) : undefined;
    return parent ? presentationById.get(parent.id) : undefined;
  };

  const clips = selection.clips.flatMap((clip) => {
    const presentation = resolvePresentation(clip);
    const presentationStart = presentation?.start ?? clip.start;
    const presentationEnd =
      presentation?.end ?? clip.start + clip.timelineDuration;
    const intersectionStart = Math.max(presentationStart, start);
    const intersectionEnd = Math.min(presentationEnd, end);
    if (intersectionStart >= intersectionEnd) {
      return [];
    }

    const startOffset = presentation
      ? presentation.mapPresentationOffsetToClipOffset(
          intersectionStart - presentation.start,
        )
      : intersectionStart - clip.start;
    const endOffset = presentation
      ? presentation.mapPresentationOffsetToClipOffset(
          intersectionEnd - presentation.start,
        )
      : intersectionEnd - clip.start;
    const captured = cropTimelineClipToOffsets(
      clip,
      startOffset,
      endOffset,
    );
    if (!captured) {
      return [];
    }
    if (captured.type === "adjustment") {
      captured.sourceDuration = captured.croppedSourceDuration;
    }
    targetPresentationStartById.set(
      captured.id,
      intersectionStart - start,
    );
    return [captured];
  });

  // First place adjustment clips from outermost to innermost, then invert the
  // resulting local ripple layout for ordinary clips. This folds ripple work
  // completed before the selection into local clip positions while preserving
  // adjustments that visibly continue inside the selected range.
  const trackPositionById = new Map(
    tracks.map((track, index) => [track.id, index] as const),
  );
  const adjustmentClips = clips
    .filter((clip) => clip.type === "adjustment")
    .sort(
      (left, right) =>
        (trackPositionById.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
        (trackPositionById.get(right.trackId) ?? Number.MAX_SAFE_INTEGER),
    );
  const positionClip = (clip: TimelineClip): void => {
    const targetStart = targetPresentationStartById.get(clip.id);
    if (targetStart === undefined) return;
    clip.start = resolveStoredStartForPresentationStart(
      tracks,
      clips,
      clip.trackId,
      targetStart,
    );
  };
  adjustmentClips.forEach(positionClip);
  clips
    .filter((clip) => clip.type !== "adjustment" && clip.type !== "mask")
    .forEach(positionClip);

  // Mask clips inherit their parent's placement and were cropped through the
  // parent's presentation map above.
  const positionedById = new Map(clips.map((clip) => [clip.id, clip] as const));
  clips.forEach((clip) => {
    if (clip.type !== "mask") return;
    const parentId = (clip as MaskTimelineClip).parentClipId;
    const parent = parentId ? positionedById.get(parentId) : undefined;
    if (parent) clip.start = parent.start;
  });

  return {
    durationTicks,
    clips: clips.map((clip) => structuredClone(clip)),
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
