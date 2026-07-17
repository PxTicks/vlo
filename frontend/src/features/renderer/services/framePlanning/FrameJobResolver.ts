import type { Asset } from "../../../../types/Asset";
import type {
  ClipTransform,
  CompositeAsset,
  CompositeContent,
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { isCompositeClip } from "../../../../types/TimelineTypes";
import {
  resolveCompositeBakeSelection,
  resolveCompositeRenderFps,
  resolveCompositeRevision,
  type CompositeBakeSelection,
} from "../../../composite";
import {
  resolveCompositeSourceDecision,
  type CompositeSourcePolicySnapshot,
} from "./CompositeSourcePolicy";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import type { ResolvedClipFrameJob } from "./framePlanningTypes";
import { collectClipTemporalRenderingRequirements } from "../../../transformations/catalogue/temporalRenderingRequirements";

const EMPTY_BAKED_COMPOSITE_CONTENT: CompositeContent = {
  durationTicks: 0,
  clips: [],
};

export interface FrameJobResolutionTrack {
  trackId: string;
  engine: TrackRenderEngine;
  trackClips: TimelineClip[];
  maskClipsByParent: ReadonlyMap<string, MaskTimelineClip[]>;
}

export interface FrameJobResolutionInput {
  epoch: number;
  presentationTick: number;
  tracks: readonly FrameJobResolutionTrack[];
  assets: readonly Asset[];
  composites?: readonly CompositeAsset[];
  logicalDimensions: { width: number; height: number };
  fps: number;
  /** Project presentation FPS used by composite content when it has no override. */
  compositeProjectFps?: number;
  transitionTransformsByClipId?: ReadonlyMap<
    string,
    readonly ClipTransform[]
  >;
  compositeSourcePolicy?: CompositeSourcePolicySnapshot;
}

export interface FrameJobResolutionResult {
  jobs: readonly ResolvedClipFrameJob[];
  assetsById: Map<string, Asset>;
  engineByJobId: Map<string, TrackRenderEngine>;
  trackInputByJobId: Map<string, FrameJobResolutionTrack>;
}

/**
 * The single active-clip/effective-time/source-frame resolution boundary.
 * Timing remains delegated to TrackRenderEngine and AdjustmentEffectResolver;
 * this facade only coordinates one immutable job per active track.
 */
export class FrameJobResolver {
  private readonly lastCompositeModeByPlacementId = new Map<
    string,
    "live" | "baked"
  >();
  private readonly bakeSelectionByCompositeId = new Map<
    string,
    {
      composite: CompositeAsset;
      assets: readonly Asset[];
      width: number;
      height: number;
      projectFps: number;
      selection: CompositeBakeSelection;
    }
  >();

  private resolveBakeSelection(
    composite: CompositeAsset,
    assets: readonly Asset[],
    logicalDimensions: { width: number; height: number },
    projectFps: number,
  ): CompositeBakeSelection {
    const cached = this.bakeSelectionByCompositeId.get(composite.id);
    if (
      cached?.composite === composite &&
      cached.assets === assets &&
      cached.width === logicalDimensions.width &&
      cached.height === logicalDimensions.height &&
      cached.projectFps === projectFps
    ) {
      return cached.selection;
    }

    const selection = resolveCompositeBakeSelection({
      composite,
      assets,
      logicalDimensions,
      projectFps,
    });
    this.bakeSelectionByCompositeId.set(composite.id, {
      composite,
      assets,
      width: logicalDimensions.width,
      height: logicalDimensions.height,
      projectFps,
      selection,
    });
    return selection;
  }

  resolve(input: FrameJobResolutionInput): FrameJobResolutionResult {
    const assetsById = new Map(
      input.assets.map((asset) => [asset.id, asset] as const),
    );
    const jobs: ResolvedClipFrameJob[] = [];
    const engineByJobId = new Map<string, TrackRenderEngine>();
    const trackInputByJobId = new Map<string, FrameJobResolutionTrack>();
    const compositeById = new Map(
      (input.composites ?? []).map((composite) => [composite.id, composite]),
    );
    for (const track of input.tracks) {
      let job = track.engine.resolveFrameJob({
        epoch: input.epoch,
        presentationTick: input.presentationTick,
        trackClips: track.trackClips,
        maskClipsByParent: track.maskClipsByParent,
        assetsById,
        logicalDimensions: input.logicalDimensions,
        fps: input.fps,
      });
      if (!job) {
        track.engine.presentBlankFrame();
        continue;
      }
      if (isCompositeClip(job.activeClip)) {
        const composite = compositeById.get(job.activeClip.compositeId);
        if (composite) {
          const compositeProjectFps = input.compositeProjectFps ?? input.fps;
          const { expectedBakeKey: bakeKey, validity } =
            this.resolveBakeSelection(
              composite,
              input.assets,
              input.logicalDimensions,
              compositeProjectFps,
            );
          const decision = resolveCompositeSourceDecision({
            compositeId: composite.id,
            validity,
            policy: input.compositeSourcePolicy,
          });
          if (decision.mode === "baked" && decision.bakeAssetId) {
            const bakeAsset = assetsById.get(decision.bakeAssetId);
            if (bakeAsset) {
              job = track.engine.retargetResolvedFrameJobAsset(
                job,
                bakeAsset,
                input.fps,
              );
            }
          }
          const previousMode = this.lastCompositeModeByPlacementId.get(
            job.activeClip.id,
          );
          const sourceChanged =
            previousMode !== undefined && previousMode !== decision.mode;
          this.lastCompositeModeByPlacementId.set(
            job.activeClip.id,
            decision.mode,
          );
          const liveContent = decision.mode === "live"
            ? structuredClone(composite.content)
            : EMPTY_BAKED_COMPOSITE_CONTENT;
          job.compositeSource = {
            mode: decision.mode,
            fallbackReason: decision.fallbackReason,
            sourceChanged,
            switchLatencyMs:
              sourceChanged &&
              decision.mode === "baked" &&
              typeof composite.bake?.updatedAt === "number"
                ? Math.max(0, Date.now() - composite.bake.updatedAt)
                : null,
            compositeId: composite.id,
            placementId: job.activeClip.id,
            revision: resolveCompositeRevision(composite),
            bakeKey,
            localPresentationTick: job.sourceFrame.sourceTimeTicks,
            logicalDimensions: input.logicalDimensions,
            fps: resolveCompositeRenderFps(
              composite.content,
              compositeProjectFps,
            ),
            content: liveContent,
            fallbackAssetId: decision.bakeAssetId,
            isStateless:
              decision.mode === "live"
                ? !composite.content.clips.some(
                    (clip) => clip.type === "extension",
                  ) &&
                  collectClipTemporalRenderingRequirements(
                    composite.content.clips,
                  ).timeDependency === "none"
                : undefined,
          };
          // A composite source is a project-logical layer even when its
          // fallback codec pads the decoded texture to an even frame size.
          // Parent fit/effect work keys must therefore never inherit decoder
          // dimensions from the previous frame.
          job.contentSize = input.logicalDimensions;
        }
      }
      const transitionTransforms =
        input.transitionTransformsByClipId?.get(job.activeClip.id);
      if (transitionTransforms?.length) {
        job.transitionTransforms = transitionTransforms;
      }
      jobs.push(job);
      engineByJobId.set(job.id, track.engine);
      trackInputByJobId.set(job.id, track);
    }

    return {
      jobs,
      assetsById,
      engineByJobId,
      trackInputByJobId,
    };
  }
}

export interface FramePlanningMismatch {
  trackId: string;
  field:
    | "activeClip"
    | "effectiveTick"
    | "sourceFrame"
    | "masks"
    | "visibility"
    | "presentationTarget";
  planned: unknown;
  legacy: unknown;
}

export function compareResolvedJobToLegacy(options: {
  job: ResolvedClipFrameJob | null;
  trackId: string;
  legacyActiveClip: TimelineClip | null;
  legacyEffectiveTick: number | null;
  legacySourceFrameKey?: string | null;
  legacyMaskClips: readonly MaskTimelineClip[];
  legacyVisible: boolean;
  legacyPresentationTarget?: string | null;
  plannedPresentationTarget?: string | null;
}): FramePlanningMismatch[] {
  const mismatches: FramePlanningMismatch[] = [];
  const { job } = options;
  const compare = (
    field: FramePlanningMismatch["field"],
    planned: unknown,
    legacy: unknown,
  ) => {
    if (JSON.stringify(planned) !== JSON.stringify(legacy)) {
      mismatches.push({ trackId: options.trackId, field, planned, legacy });
    }
  };

  compare("activeClip", job?.activeClip.id ?? null, options.legacyActiveClip?.id ?? null);
  compare("effectiveTick", job?.effectiveTrackTick ?? null, options.legacyEffectiveTick);
  compare(
    "sourceFrame",
    job?.sourceFrame.key ?? null,
    options.legacySourceFrameKey ?? null,
  );
  compare(
    "masks",
    job?.maskClips.map((mask) => mask.id) ?? [],
    options.legacyMaskClips.map((mask) => mask.id),
  );
  compare("visibility", !!job, options.legacyVisible);
  compare(
    "presentationTarget",
    options.plannedPresentationTarget ?? null,
    options.legacyPresentationTarget ?? null,
  );
  return mismatches;
}
