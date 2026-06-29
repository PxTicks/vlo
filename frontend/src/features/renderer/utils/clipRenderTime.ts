import type { TimelineClip } from "../../../types/TimelineTypes";
import { clipVisualToSourceTime } from "../../transformations/utils/clipTimeDomains";
import { tickToMediaSeconds } from "./mediaTime";

export interface ResolvedClipRenderTime {
  /**
   * Global timeline tick requested by the caller. When a caller has already
   * resolved adjustment timing and no longer has the original presentation
   * tick, this intentionally mirrors `effectiveTrackTick`.
   */
  presentationTick: number;
  /**
   * Global timeline tick after adjustment/presentation retiming has been
   * applied for this clip.
   */
  effectiveTrackTick: number;
  /**
   * Clip-local visual tick. Layout/path transforms use this domain because
   * they describe where the rendered clip is in its visual footprint.
   */
  clipVisualTimeTicks: number;
  /**
   * Source-media time in project ticks. Media-owned keyframes (volume, audio
   * effects, filter values) use this domain so speed changes when content is
   * presented, not which values belong to that content.
   */
  sourceTimeTicks: number;
  /**
   * The same source-media time at the external media API boundary.
   */
  sourceTimeSeconds: number;
}

export interface ResolveClipRenderTimeOptions {
  clip: TimelineClip;
  presentationTick: number;
  resolveEffectiveTrackTick?: (
    clip: TimelineClip,
    presentationTick: number,
  ) => number;
}

export interface ResolveClipRenderTimeFromEffectiveTickOptions {
  clip: TimelineClip;
  effectiveTrackTick: number;
  presentationTick?: number;
}

export function resolveClipRenderTimeFromEffectiveTick({
  clip,
  effectiveTrackTick,
  presentationTick = effectiveTrackTick,
}: ResolveClipRenderTimeFromEffectiveTickOptions): ResolvedClipRenderTime {
  const clipVisualTimeTicks = effectiveTrackTick - clip.start;
  const sourceTimeTicks = clipVisualToSourceTime(clip, clipVisualTimeTicks);

  return {
    presentationTick,
    effectiveTrackTick,
    clipVisualTimeTicks,
    sourceTimeTicks,
    sourceTimeSeconds: tickToMediaSeconds(sourceTimeTicks),
  };
}

export function resolveClipRenderTime({
  clip,
  presentationTick,
  resolveEffectiveTrackTick,
}: ResolveClipRenderTimeOptions): ResolvedClipRenderTime {
  const effectiveTrackTick = resolveEffectiveTrackTick
    ? resolveEffectiveTrackTick(clip, presentationTick)
    : presentationTick;

  return resolveClipRenderTimeFromEffectiveTick({
    clip,
    presentationTick,
    effectiveTrackTick,
  });
}
