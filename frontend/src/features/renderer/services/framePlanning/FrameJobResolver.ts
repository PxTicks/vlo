import type { Asset } from "../../../../types/Asset";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import type { ResolvedClipFrameJob } from "./framePlanningTypes";

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
  logicalDimensions: { width: number; height: number };
  fps: number;
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
