import type {
  CompositeAsset,
  VideoBaseClip,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import { resolveCompositeRevision } from "./compositeBakeValidity";

export interface CreateCompositePlacementArgs {
  id?: string;
  compositeId: string;
  compositeRevision?: number;
  assetId: string;
  durationTicks: number;
  name?: string;
}

function buildCompositeBaseClip(
  args: CreateCompositePlacementArgs,
): VideoBaseClip {
  const duration = Math.max(1, Math.round(args.durationTicks));
  return {
    id: args.id ?? `clip_${crypto.randomUUID()}`,
    type: "video",
    name: args.name ?? "Composite",
    assetId: args.assetId,
    compositeId: args.compositeId,
    ...(args.compositeRevision
      ? { compositeRevision: args.compositeRevision }
      : {}),
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

function resolveCompositePlacementAssetId(composite: CompositeAsset): string {
  // Persistence still requires an asset-shaped clip during the compatibility
  // window, but render/audio source policy resolves canonical composite state.
  return `composite-live:${composite.id}`;
}

export function createCompositeBaseClipFromAsset(
  composite: CompositeAsset,
  options: { id?: string; durationTicks?: number } = {},
): VideoBaseClip {
  return buildCompositeBaseClip({
    id: options.id,
    compositeId: composite.id,
    compositeRevision: resolveCompositeRevision(composite),
    assetId: resolveCompositePlacementAssetId(composite),
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
