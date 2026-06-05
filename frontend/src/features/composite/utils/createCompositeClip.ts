import type {
  CompositeAsset,
  VideoBaseClip,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";


export interface CreateCompositePlacementArgs {
  id?: string;
  compositeId: string;
  assetId: string;
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
