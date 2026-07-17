import type { Asset } from "../../../../types/Asset";
import type {
  ClipTransform,
  CompositeAsset,
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { isCompositeClip } from "../../../../types/TimelineTypes";
import {
  createCompositeBakeKey,
  isCompositeForceLive,
  resolveCompositeBakeValidity,
  resolveCompositeRenderFps,
  resolveCompositeRevision,
  serializeCompositeBakeKey,
} from "../../../composite";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import type { ResolvedClipFrameJob } from "./framePlanningTypes";
import { isCompositeRenderDagEnabled } from "./framePlanningFlags";

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
    const availableAssetIds = new Set(input.assets.map((asset) => asset.id));

    for (const track of input.tracks) {
      const job = track.engine.resolveFrameJob({
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
      if (
        isCompositeRenderDagEnabled() &&
        isCompositeClip(job.activeClip)
      ) {
        const composite = compositeById.get(job.activeClip.compositeId);
        if (composite) {
          const compositeProjectFps = input.compositeProjectFps ?? input.fps;
          const bakeKey = serializeCompositeBakeKey(
            createCompositeBakeKey({
              content: composite.content,
              projectFps: compositeProjectFps,
              logicalDimensions: input.logicalDimensions,
              assets: input.assets,
            }),
          );
          const validity = resolveCompositeBakeValidity({
            composite,
            expectedBakeKey: bakeKey,
            availableAssetIds,
          });
          // TODO(phase5): source policy must be passed as a frame/export
          // snapshot. Reading the runtime force-live store here is suitable
          // for preview but lets a UI toggle alter later frames of an export.
          const useBakedSource =
            !isCompositeForceLive(composite.id) &&
            validity.valid &&
            validity.assetId === job.activeClip.assetId;
          job.compositeSource = {
            mode: useBakedSource ? "baked" : "live",
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
            content: structuredClone(composite.content),
            fallbackAssetId: useBakedSource ? validity.assetId : null,
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
