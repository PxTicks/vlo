import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  collectTemporalRenderingRequirements,
  getTemporalClipSourceIdentity,
  getTemporalTransformationTopologyKey,
  type TemporalRenderingRequirements,
} from "../../transformations/catalogue/temporalRenderingRequirements";
import type { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";

export interface TemporalFrameScopeTrack {
  trackId: string;
  trackClips: TimelineClip[];
  activeClipResolver: {
    resolveActiveClipAtPresentation(
      trackClips: TimelineClip[],
      presentationTick: number,
    ): {
      activeClip: TimelineClip;
      effectiveTick: number;
      presentationStart: number;
    } | null;
  };
}

export interface TemporalFrameScope {
  requirements: TemporalRenderingRequirements;
  earliestTick: number;
  topologyKey: string;
}

export interface CollectTemporalFrameScopeOptions {
  presentationTick: number;
  tracks: readonly TemporalFrameScopeTrack[];
  stableClips: readonly TimelineClip[];
  adjustmentEffectResolver: AdjustmentEffectResolver;
}

/**
 * Resolves temporal policy in the same presentation domain as the supplied
 * track engines. Composite runtimes use child-local ticks here; parent preview
 * and export use project ticks. Keeping the collector domain-agnostic avoids
 * approximating retimed child history in the parent clock.
 */
export function collectTemporalFrameScope({
  presentationTick,
  tracks,
  stableClips,
  adjustmentEffectResolver,
}: CollectTemporalFrameScopeOptions): TemporalFrameScope {
  const activeTransformationSets: TimelineClip["transformations"][] = [];
  const activeSourceIdentities: string[] = [];
  const temporalStartTicks: number[] = [];

  for (const track of tracks) {
    const active = track.activeClipResolver.resolveActiveClipAtPresentation(
      track.trackClips,
      presentationTick,
    );
    if (!active) continue;

    const transformations = active.activeClip.transformations ?? [];
    activeTransformationSets.push(transformations);
    activeSourceIdentities.push(
      getTemporalClipSourceIdentity(active.activeClip),
    );
    if (
      collectTemporalRenderingRequirements([transformations]).timeDependency !==
      "none"
    ) {
      temporalStartTicks.push(active.presentationStart);
    }
  }

  const collectGroups = (
    groups: ReturnType<AdjustmentEffectResolver["deriveGroups"]>,
  ): void => {
    for (const group of groups) {
      const transformations = group.transformations ?? [];
      activeTransformationSets.push(transformations);
      if (
        collectTemporalRenderingRequirements([transformations])
          .timeDependency !== "none"
      ) {
        const localElapsed = Math.max(
          0,
          (group.sampleTick ?? presentationTick) - group.start,
        );
        temporalStartTicks.push(presentationTick - localElapsed);
      }
      collectGroups(group.children);
    }
  };
  collectGroups(adjustmentEffectResolver.deriveGroups(presentationTick));

  return {
    requirements: collectTemporalRenderingRequirements(
      activeTransformationSets,
    ),
    earliestTick:
      temporalStartTicks.length > 0 ? Math.min(...temporalStartTicks) : 0,
    topologyKey: [
      getTemporalTransformationTopologyKey(
        stableClips.map((clip) => clip.transformations ?? []),
      ),
      ...activeSourceIdentities,
    ].join("::"),
  };
}
