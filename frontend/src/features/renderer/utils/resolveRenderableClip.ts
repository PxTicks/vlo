import type { Asset } from "../../../types/Asset";
import type {
  AudioTimelineClip,
  CompositeTimelineClip,
  TimelineClip,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import { durationSecondsToTicks } from "../../timeline/utils/assetDuration";
import { isCompositeProxyStale } from "../../timelineSelection";

function isCompositeFullLengthTiming(clip: CompositeTimelineClip): boolean {
  return (
    clip.sourceDuration !== null &&
    clip.offset === 0 &&
    clip.transformedOffset === 0 &&
    clip.timelineDuration === clip.sourceDuration &&
    clip.croppedSourceDuration === clip.sourceDuration &&
    clip.transformedDuration === clip.sourceDuration
  );
}

/**
 * The render boundary for Composite clips (prebaked-proxy strategy).
 *
 * A composite clip is flattened to a plain video clip pointed at its baked
 * proxy asset, preserving id, track, timing, transforms and components. Every
 * downstream consumer (TrackRenderEngine decode, applyClipTransforms, the mask
 * controller, audio) then treats it exactly like a video clip — so the renderer
 * never needs a `composite` branch.
 *
 * Returns the clip unchanged when it isn't a composite, and `null` when a
 * composite has no usable proxy yet (renders as empty until the bake lands).
 */
export function resolveRenderableClip(
  clip: TimelineClip,
  assetsById: Map<string, Asset>,
): TimelineClip | null {
  if (clip.type !== "composite") {
    return clip;
  }

  const { proxyAssetId } = clip;
  if (!proxyAssetId || isCompositeProxyStale(clip) || !assetsById.has(proxyAssetId)) {
    return null;
  }
  const proxyAsset = assetsById.get(proxyAssetId);
  const proxyDurationTicks = durationSecondsToTicks(proxyAsset?.duration);
  const flattenedDurationTicks =
    proxyDurationTicks !== null && isCompositeFullLengthTiming(clip)
      ? proxyDurationTicks
      : null;

  // Build the proxy-backed video clip explicitly so the composite-only fields
  // (content, proxy*) don't leak downstream.
  const flattened: VideoTimelineClip = {
    id: clip.id,
    type: "video",
    name: clip.name,
    assetId: proxyAssetId,
    trackId: clip.trackId,
    start: clip.start,
    sourceDuration: flattenedDurationTicks ?? clip.sourceDuration,
    timelineDuration: flattenedDurationTicks ?? clip.timelineDuration,
    croppedSourceDuration:
      flattenedDurationTicks ?? clip.croppedSourceDuration,
    offset: clip.offset,
    transformedDuration: flattenedDurationTicks ?? clip.transformedDuration,
    transformedOffset: clip.transformedOffset,
    transformations: clip.transformations,
    ...(clip.components ? { components: clip.components } : {}),
    ...(clip.isMuted !== undefined ? { isMuted: clip.isMuted } : {}),
  };
  return flattened;
}

/**
 * Maps a clip list through {@link resolveRenderableClip}, dropping composites
 * that have no usable proxy. Order is preserved.
 */
export function resolveRenderableClips(
  clips: TimelineClip[],
  assetsById: Map<string, Asset>,
): TimelineClip[] {
  const resolved: TimelineClip[] = [];
  for (const clip of clips) {
    const renderable = resolveRenderableClip(clip, assetsById);
    if (renderable) {
      resolved.push(renderable);
    }
  }
  return resolved;
}

function isAudioOnlyComposite(clip: TimelineClip): clip is CompositeTimelineClip {
  return clip.type === "composite" && clip.contentKind === "audio";
}

function createSyntheticAudioClipFromCompositeChild(
  parent: CompositeTimelineClip,
  child: AudioTimelineClip,
): AudioTimelineClip {
  return {
    id: `${parent.id}::${child.id}`,
    type: "audio",
    name: `${parent.name} / ${child.name}`,
    assetId: child.assetId,
    trackId: parent.trackId,
    start: parent.start,
    sourceDuration: child.sourceDuration,
    timelineDuration: parent.timelineDuration,
    croppedSourceDuration: child.croppedSourceDuration,
    offset: child.offset,
    transformedDuration: parent.timelineDuration,
    transformedOffset: 0,
    transformations: parent.transformations,
    ...(parent.isMuted || child.isMuted ? { isMuted: true } : {}),
  };
}

/**
 * Audio render boundary for both normal clips and audio-only composites.
 *
 * Each returned lane is intended for one TrackAudioRenderer instance. Regular
 * video/audio/proxy clips share lane 0. Every nested audio clip in an
 * audio-only composite gets its own lane so overlapping target/residual stems
 * are mixed instead of one suppressing the other on the same parent track.
 */
export function resolveRenderableAudioClipLanes(
  clips: TimelineClip[],
  assetsById: Map<string, Asset>,
): TimelineClip[][] {
  const mainLane: TimelineClip[] = [];
  const lanes: TimelineClip[][] = [mainLane];

  for (const clip of clips) {
    if (isAudioOnlyComposite(clip)) {
      const tracksById = new Map(
        (clip.content.tracks ?? []).map((track) => [track.id, track] as const),
      );
      for (const child of clip.content.clips) {
        if (child.type !== "audio") continue;
        const nestedTrack = tracksById.get(child.trackId);
        if (nestedTrack?.isMuted || nestedTrack?.isVisible === false) continue;
        if (!assetsById.has(child.assetId)) continue;
        lanes.push([createSyntheticAudioClipFromCompositeChild(clip, child)]);
      }
      continue;
    }

    const renderable = resolveRenderableClip(clip, assetsById);
    if (
      renderable &&
      (renderable.type === "video" || renderable.type === "audio")
    ) {
      mainLane.push(renderable);
    }
  }

  return lanes.filter((lane) => lane.length > 0);
}
