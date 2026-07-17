import type { Asset } from "../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { isCompositeClip } from "../../../types/TimelineTypes";
import { resolveCompositeBakeSelection } from "../../composite";
import { sortTrackClipsByStart, resolveLiveActiveClip } from "../utils/clipLookup";
import { resolveClipRenderTime } from "../utils/clipRenderTime";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import {
  resolveCompositeSourceDecision,
  type CompositeSourcePolicySnapshot,
} from "./framePlanning/CompositeSourcePolicy";
import type {
  TrackAudioActiveClipResolution,
  TrackAudioTimingResolver,
} from "./TrackAudioRenderer";

export interface CompositeAudioSourceData {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  composites: readonly CompositeAsset[];
  assets: readonly Asset[];
  projectFps: number;
  logicalDimensions: { width: number; height: number };
  sourcePolicy?: CompositeSourcePolicySnapshot;
}

export interface CompositeAudioLanePlan {
  id: string;
  clips: TimelineClip[];
  timingResolver: TrackAudioTimingResolver;
}

export interface DirectCompositeAudioPlacementPlan {
  parentClip: TimelineClip;
  composite: CompositeAsset;
  lanes: CompositeAudioLanePlan[];
  parentTiming: CompositeAudioParentTiming;
}

export interface CompositeAudioParentTiming {
  isActiveAt(presentationTick: number): boolean;
  sourceTicksAt(presentationTick: number): number;
}

export interface CompositeAudioTrackPlan {
  mainClips: TimelineClip[];
  directPlacements: DirectCompositeAudioPlacementPlan[];
}

interface ParentTimeResolution {
  localTick: number;
  effectiveTick: number;
}

function resolveParentTime(options: {
  parentClip: TimelineClip;
  parentResolver: AdjustmentEffectResolver;
  presentationTick: number;
  requireActive: boolean;
}): ParentTimeResolution | null {
  const { parentClip, parentResolver, presentationTick } = options;

  if (options.requireActive) {
    const active = resolveLiveActiveClip(
      parentResolver,
      parentClip.trackId,
      [parentClip],
      presentationTick,
    );
    if (!active || active.clip.id !== parentClip.id) return null;
  }

  const effectiveTick = parentResolver
    .getPresentationLookup()
    .resolveEffectiveTrackTickWithinClip(parentClip, presentationTick);
  const localTick = resolveClipRenderTime({
    clip: parentClip,
    presentationTick,
    resolveEffectiveTrackTick: () => effectiveTick,
  }).sourceTimeTicks;

  return { localTick, effectiveTick };
}

function findChildClipWithoutAdjustment(
  clips: readonly TimelineClip[],
  localTick: number,
): TimelineClip | null {
  for (const clip of clips) {
    if (clip.start <= localTick && localTick < clip.start + clip.timelineDuration) {
      return clip;
    }
  }
  return null;
}

class CompositeChildAudioTimingResolver implements TrackAudioTimingResolver {
  private readonly originalBySyntheticId = new Map<string, TimelineClip>();
  private readonly syntheticByOriginalId = new Map<string, TimelineClip>();
  private readonly parentClip: TimelineClip;
  private readonly parentResolver: AdjustmentEffectResolver;
  private readonly childTrackId: string;
  private readonly childClips: readonly TimelineClip[];
  private readonly childResolver: AdjustmentEffectResolver;

  constructor(
    parentClip: TimelineClip,
    parentResolver: AdjustmentEffectResolver,
    childTrackId: string,
    childClips: readonly TimelineClip[],
    childResolver: AdjustmentEffectResolver,
    syntheticClips: readonly TimelineClip[],
  ) {
    this.parentClip = parentClip;
    this.parentResolver = parentResolver;
    this.childTrackId = childTrackId;
    this.childClips = childClips;
    this.childResolver = childResolver;
    for (let index = 0; index < childClips.length; index += 1) {
      const original = childClips[index];
      const synthetic = syntheticClips[index];
      this.originalBySyntheticId.set(synthetic.id, original);
      this.syntheticByOriginalId.set(original.id, synthetic);
    }
  }

  findActiveClipAtPresentation(
    _trackClips: readonly TimelineClip[],
    presentationTick: number,
  ): TrackAudioActiveClipResolution | null {
    const parentTime = resolveParentTime({
      parentClip: this.parentClip,
      parentResolver: this.parentResolver,
      presentationTick,
      requireActive: true,
    });
    if (!parentTime) return null;

    const adjusted = resolveLiveActiveClip(
      this.childResolver,
      this.childTrackId,
      this.childClips,
      parentTime.localTick,
    );
    const original =
      adjusted?.clip ??
      findChildClipWithoutAdjustment(this.childClips, parentTime.localTick);
    if (!original) return null;

    const synthetic = this.syntheticByOriginalId.get(original.id);
    if (!synthetic) return null;

    return {
      clip: synthetic,
      effectiveTick: adjusted?.effectiveTick ?? parentTime.localTick,
    };
  }

  getSourceTicksAtPresentationTick(
    clip: TimelineClip,
    presentationTick: number,
  ): number {
    const original = this.originalBySyntheticId.get(clip.id);
    if (!original) return 0;

    const parentTime = resolveParentTime({
      parentClip: this.parentClip,
      parentResolver: this.parentResolver,
      presentationTick,
      requireActive: false,
    });
    if (!parentTime) return 0;

    return resolveClipRenderTime({
      clip: original,
      presentationTick: parentTime.localTick,
      resolveEffectiveTrackTick: (targetClip, tick) =>
        this.childResolver
          .getPresentationLookup()
          .resolveEffectiveTrackTickWithinClip(targetClip, tick),
    }).sourceTimeTicks;
  }
}

function createChildTrackFallbacks(
  composite: CompositeAsset,
): TimelineTrack[] {
  const declared = composite.content.tracks ?? [];
  if (declared.length > 0) return structuredClone(declared);

  const trackIds = new Set(composite.content.clips.map((clip) => clip.trackId));
  return [...trackIds].map((id) => ({
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  }));
}

function createDirectPlacementPlan(options: {
  parentClip: TimelineClip;
  composite: CompositeAsset;
  parentResolver: AdjustmentEffectResolver;
  projectFps: number;
}): DirectCompositeAudioPlacementPlan {
  const childTracks = createChildTrackFallbacks(options.composite);
  const childClips = structuredClone(options.composite.content.clips);
  const childResolver = new AdjustmentEffectResolver();
  childResolver.setAdjustmentSource(
    childTracks,
    childClips,
    options.composite.content.fps ?? options.projectFps,
  );

  const includedTrackIds = new Set(
    options.composite.content.includedTrackIds ?? [],
  );
  const lanes: CompositeAudioLanePlan[] = [];

  for (const track of childTracks) {
    if (
      (track.type !== "visual" && track.type !== "audio") ||
      !track.isVisible ||
      track.isMuted ||
      (includedTrackIds.size > 0 && !includedTrackIds.has(track.id))
    ) {
      continue;
    }

    const originals = sortTrackClipsByStart(
      childClips.filter(
        (clip) =>
          clip.trackId === track.id &&
          (clip.type === "video" || clip.type === "audio"),
      ),
    );
    if (originals.length === 0) continue;

    const laneId = `composite-audio:${options.parentClip.id}:${track.id}`;
    const syntheticClips = originals.map((clip) => ({
      ...structuredClone(clip),
      id: `${laneId}:${clip.id}`,
      trackId: laneId,
    }));
    lanes.push({
      id: laneId,
      clips: syntheticClips,
      timingResolver: new CompositeChildAudioTimingResolver(
        options.parentClip,
        options.parentResolver,
        track.id,
        originals,
        childResolver,
        syntheticClips,
      ),
    });
  }

  return {
    parentClip: structuredClone(options.parentClip),
    composite: structuredClone(options.composite),
    lanes,
    parentTiming: {
      isActiveAt: (presentationTick) =>
        resolveParentTime({
          parentClip: options.parentClip,
          parentResolver: options.parentResolver,
          presentationTick,
          requireActive: true,
        }) !== null,
      sourceTicksAt: (presentationTick) =>
        resolveParentTime({
          parentClip: options.parentClip,
          parentResolver: options.parentResolver,
          presentationTick,
          requireActive: false,
        })?.localTick ?? 0,
    },
  };
}

/**
 * Resolve one immutable transport/export audio plan. Matching bakes stay on
 * the ordinary media path; every other valid composite is expanded into
 * private child lanes that share one parent mix bus.
 */
export function createCompositeAudioTrackPlan(
  trackId: string,
  source: CompositeAudioSourceData,
): CompositeAudioTrackPlan {
  const sourceClips = sortTrackClipsByStart(
    source.clips.filter((clip) => clip.trackId === trackId),
  );
  const parentResolver = new AdjustmentEffectResolver();
  parentResolver.setAdjustmentSource(
    structuredClone(source.tracks),
    structuredClone(source.clips),
    source.projectFps,
  );

  const compositeById = new Map(
    source.composites.map((composite) => [composite.id, composite] as const),
  );
  const mainClips: TimelineClip[] = [];
  const directPlacements: DirectCompositeAudioPlacementPlan[] = [];

  for (const clip of sourceClips) {
    if (!isCompositeClip(clip)) {
      mainClips.push(structuredClone(clip));
      continue;
    }

    const composite = compositeById.get(clip.compositeId);
    if (!composite) {
      mainClips.push(structuredClone(clip));
      continue;
    }

    const { validity } = resolveCompositeBakeSelection({
      composite,
      projectFps: source.projectFps,
      logicalDimensions: source.logicalDimensions,
      assets: source.assets,
    });
    const decision = resolveCompositeSourceDecision({
      compositeId: composite.id,
      validity,
      policy: source.sourcePolicy,
    });

    if (decision.mode === "baked" && decision.bakeAssetId) {
      mainClips.push(
        structuredClone({ ...clip, assetId: decision.bakeAssetId }),
      );
      continue;
    }

    directPlacements.push(
      createDirectPlacementPlan({
        parentClip: structuredClone(clip),
        composite,
        parentResolver,
        projectFps: source.projectFps,
      }),
    );
  }

  return {
    mainClips: sortTrackClipsByStart(mainClips),
    directPlacements,
  };
}
