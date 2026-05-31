import type { Asset } from "../../../types/Asset";
import type {
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
