import type {
  CompositeAsset,
  VideoBaseClip,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";

/**
 * A composite placement is an ordinary asset-backed video clip pointed at the
 * composite's baked asset, tagged with `compositeId` purely so the timeline UI
 * can show the badge / reveal / open-to-edit. The renderer treats it like any
 * other video clip — there is no composite-specific render path.
 */
export interface CreateCompositePlacementArgs {
  id?: string;
  compositeId: string;
  assetId: string;
  /** Untrimmed clip length in ticks (defaults to the composite content length). */
  durationTicks: number;
  name?: string;
}

function buildCompositeBaseClip(args: CreateCompositePlacementArgs): VideoBaseClip {
  const duration = Math.max(1, Math.round(args.durationTicks));
  return {
    id: args.id ?? `clip_${crypto.randomUUID()}`,
    type: "video",
    name: args.name ?? "Composite",
    assetId: args.assetId,
    compositeId: args.compositeId,
    sourceDuration: duration,
    timelineDuration: duration,
    croppedSourceDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    transformations: [],
  };
}

export function createCompositeTimelineClip(
  args: CreateCompositePlacementArgs & { trackId: string; start: number },
): VideoTimelineClip {
  return {
    ...buildCompositeBaseClip(args),
    trackId: args.trackId,
    start: args.start,
  };
}

function requireBakedAssetId(composite: CompositeAsset): string {
  if (!composite.bakedAssetId) {
    throw new Error(
      `Composite '${composite.id}' has no baked asset to place yet.`,
    );
  }
  return composite.bakedAssetId;
}

export function createCompositeBaseClipFromAsset(
  composite: CompositeAsset,
  options: { id?: string; durationTicks?: number } = {},
): VideoBaseClip {
  return buildCompositeBaseClip({
    id: options.id,
    compositeId: composite.id,
    assetId: requireBakedAssetId(composite),
    durationTicks: options.durationTicks ?? composite.content.durationTicks,
    name: composite.name,
  });
}

export function createCompositeTimelineClipFromAsset(
  composite: CompositeAsset,
  args: { id?: string; trackId: string; start: number; durationTicks?: number },
): VideoTimelineClip {
  return {
    ...createCompositeBaseClipFromAsset(composite, {
      id: args.id,
      durationTicks: args.durationTicks,
    }),
    trackId: args.trackId,
    start: args.start,
  };
}
