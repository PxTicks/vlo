import type {
  CompositeContent,
  CompositeTimelineClip,
} from "../../../types/TimelineTypes";

export interface CreateCompositeClipArgs {
  content: CompositeContent;
  trackId: string;
  /** Global timeline start position (ticks). */
  start: number;
  proxyAssetId?: string;
  proxyContentHash?: string;
  name?: string;
}

/**
 * Builds a Composite timeline clip whose timing mirrors its content's natural
 * length. Because a composite renders through its baked proxy (a project-sized
 * video), its timing fields are a 1:1, untrimmed, unsped mapping of the
 * content duration — trims/speed are then applied like any other clip.
 */
export function createCompositeTimelineClip(
  args: CreateCompositeClipArgs,
): CompositeTimelineClip {
  const duration = Math.max(1, Math.round(args.content.durationTicks));

  return {
    id: `clip_${crypto.randomUUID()}`,
    type: "composite",
    name: args.name ?? "Composite",
    trackId: args.trackId,
    start: args.start,
    sourceDuration: duration,
    timelineDuration: duration,
    croppedSourceDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    transformations: [],
    content: args.content,
    ...(args.proxyAssetId ? { proxyAssetId: args.proxyAssetId } : {}),
    ...(args.proxyContentHash
      ? { proxyContentHash: args.proxyContentHash }
      : {}),
  };
}
