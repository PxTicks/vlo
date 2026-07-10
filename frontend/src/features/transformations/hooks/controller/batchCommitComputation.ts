import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { isDefaultTransform } from "../../catalogue/TransformationRegistry";
import { insertTransformRespectingDefaultOrder } from "./transformOrdering";
import { computeCommitMutation } from "./commitComputation";

interface BatchCommitComputationInput {
  groupId: string;
  values: Readonly<Record<string, unknown>>;
  transformId?: string;
  transforms: ClipTransform[];
  activeClip?: TimelineClip;
  playheadTicks: number;
  pointEpsilonTicks: number;
  keyframeSourceTimeTicks?: number;
}

export function computeBatchCommitMutations({
  groupId,
  values,
  transformId: initialTransformId,
  transforms,
  activeClip,
  playheadTicks,
  pointEpsilonTicks,
  keyframeSourceTimeTicks,
}: BatchCommitComputationInput): ClipTransform[] {
  let nextTransforms = transforms;
  let transformId = initialTransformId;

  for (const [controlName, value] of Object.entries(values)) {
    const commit = computeCommitMutation({
      groupId,
      controlName,
      value,
      transformId,
      transforms: nextTransforms,
      activeClip,
      playheadTicks,
      pointEpsilonTicks,
      keyframeSourceTimeTicks,
    });

    if (commit.mode === "update") {
      nextTransforms = nextTransforms.map((transform) =>
        transform.id === commit.existingTransform.id
          ? {
              ...transform,
              parameters: commit.parameters,
              ...(commit.keyframeTimes !== undefined
                ? { keyframeTimes: commit.keyframeTimes }
                : {}),
            }
          : transform,
      );
      continue;
    }

    nextTransforms = isDefaultTransform(commit.createdTransform.type)
      ? insertTransformRespectingDefaultOrder(
          nextTransforms,
          commit.createdTransform,
        )
      : [...nextTransforms, commit.createdTransform];
    transformId = commit.createdTransform.id;
  }

  return nextTransforms;
}
