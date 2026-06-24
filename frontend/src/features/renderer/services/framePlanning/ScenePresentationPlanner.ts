import type { DerivedRenderGroup } from "../../utils/deriveAdjustmentGroups";
import type {
  OutputSinkCommand,
  ResolvedClipFrameJob,
  ScenePresentationPlan,
  TrackPresentationCommand,
} from "./framePlanningTypes";

function buildParentGroupByTrack(
  forest: readonly DerivedRenderGroup[],
): Map<string, string> {
  const parentByTrack = new Map<string, string>();
  const walk = (group: DerivedRenderGroup): void => {
    for (const trackId of group.trackIds) {
      parentByTrack.set(trackId, group.id);
    }
    for (const child of group.children) {
      walk(child);
    }
  };
  for (const group of forest) {
    walk(group);
  }
  return parentByTrack;
}

export function buildScenePresentationPlan(options: {
  epoch: number;
  visualTrackOrder: readonly string[];
  jobs: readonly ResolvedClipFrameJob[];
  adjustmentForest: readonly DerivedRenderGroup[];
  zIndexOverrides?: ReadonlyMap<string, number>;
  transitionColorLayers?: ScenePresentationPlan["transitionColorLayers"];
  outputIds?: readonly string[];
}): ScenePresentationPlan {
  const jobByTrackId = new Map(
    options.jobs.map((job) => [job.trackId, job] as const),
  );
  const parentGroupByTrack = buildParentGroupByTrack(options.adjustmentForest);
  const tracks: TrackPresentationCommand[] = options.visualTrackOrder.map(
    (trackId, index) => {
      const job = jobByTrackId.get(trackId);
      return {
        trackId,
        jobId: job?.id ?? null,
        visible: !!job,
        parentGroupId: parentGroupByTrack.get(trackId) ?? null,
        zIndex:
          options.zIndexOverrides?.get(trackId) ??
          options.visualTrackOrder.length - 1 - index,
      };
    },
  );
  const encoderSinks: OutputSinkCommand[] = (options.outputIds ?? []).map(
    (id) => ({ id, source: "project-composite" }),
  );

  return {
    epoch: options.epoch,
    tracks,
    adjustmentForest: options.adjustmentForest,
    transitionColorLayers: options.transitionColorLayers ?? [],
    encoderSinks,
  };
}
