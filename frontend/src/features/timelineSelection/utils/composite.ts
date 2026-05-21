import type {
  CompositeContent,
  CompositeTimelineClip,
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";

/**
 * Adapters between a {@link TimelineSelection} (anchored at absolute timeline
 * ticks) and a {@link CompositeContent} (the same region normalized to local
 * zero so it can live inside a portable Composite clip).
 *
 * The whole point of the Composite "prebaked proxy" strategy is that a
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

function cloneTracks(tracks: TimelineTrack[] | undefined): TimelineTrack[] | undefined {
  return tracks ? structuredClone(tracks) : undefined;
}

/** Largest clip end (absolute ticks) across a region's clips, or `fallback`. */
function inferRegionEnd(clips: TimelineClip[], fallback: number): number {
  return clips.reduce(
    (max, clip) => Math.max(max, clip.start + clip.timelineDuration),
    fallback,
  );
}

/**
 * Captures a selection as portable composite content: every clip (including
 * subordinate mask clips) is shifted so the window's start lands on tick 0.
 * Clips that began before the window keep a negative start, so only the portion
 * inside the window is visible — exactly as the selection rendered in place.
 */
export function selectionToCompositeContent(
  selection: TimelineSelection,
): CompositeContent {
  const start = selection.start;
  const end = selection.end ?? inferRegionEnd(selection.clips, start);
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

  if (clip.type === "composite") {
    // Nested composites contribute their own content recursively.
    return { ...common, content: projectContentForHash(clip.content) };
  }
  if (clip.type === "mask") {
    // Mask clips carry no components; their full record is part of the matte.
    return { ...common, mask: clip as unknown as Record<string, unknown> };
  }

  return {
    ...common,
    isMuted: clip.isMuted ?? false,
    components: clip.components ?? [],
    ...("assetId" in clip ? { assetId: clip.assetId } : {}),
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
 * Stable hash of the content's bake-affecting structure. Stored on a baked
 * composite clip as `proxyContentHash`; a mismatch against the live content
 * means the proxy is stale and should be re-baked.
 */
export function hashCompositeContent(content: CompositeContent): string {
  return djb2(JSON.stringify(projectContentForHash(content)));
}

/** True when `clip`'s proxy is missing or was baked from different content. */
export function isCompositeProxyStale(clip: CompositeTimelineClip): boolean {
  if (!clip.proxyAssetId || !clip.proxyContentHash) {
    return true;
  }
  return clip.proxyContentHash !== hashCompositeContent(clip.content);
}
