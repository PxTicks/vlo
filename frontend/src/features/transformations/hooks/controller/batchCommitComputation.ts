import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { isDefaultTransform } from "../../catalogue/TransformationRegistry";
import { isSplineParameter } from "../../types";
import { insertTransformRespectingDefaultOrder } from "./transformOrdering";
import { computeCommitMutation, resolveCommitKeyframeTime } from "./commitComputation";
import {
  completeLayoutKeyframeCommit,
  isLayoutKeyframeGroupType,
  prepareLayoutKeyframeCommit,
} from "../../utils/layoutKeyframeGroup";

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
  // Grade presets and paste are replacement operations, not edits at the
  // current playhead. Rebuild the transform-wide keyframe index from the
  // resulting parameters so scalar replacements remove stale diamonds and
  // imported splines register all of their points.
  if (groupId === "color_grade_management" && initialTransformId) {
    return transforms.map((transform) => {
      if (transform.id !== initialTransformId) return transform;
      const parameters = {
        ...transform.parameters,
        ...structuredClone(values),
      };
      const keyframeTimes = Array.from(
        new Set(
          Object.values(parameters).flatMap((value) =>
            isSplineParameter(value)
              ? value.points.map((point) => point.time)
              : [],
          ),
        ),
      ).sort((left, right) => left - right);
      return { ...transform, parameters, keyframeTimes };
    });
  }

  // Layout groups share one keyframe track (see layoutKeyframeGroup): key the
  // target into it first, then key the siblings at the commit time.
  const keyLayoutTrack =
    isLayoutKeyframeGroupType(groupId) &&
    activeClip !== undefined &&
    Object.values(values).every((value) => typeof value === "number");
  let nextTransforms = keyLayoutTrack
    ? prepareLayoutKeyframeCommit(
        transforms,
        groupId,
        initialTransformId,
        pointEpsilonTicks,
      )
    : transforms;
  let transformId = initialTransformId;
  const applyLinkedControls = Object.keys(values).length <= 1;

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
      applyLinkedControls,
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

  if (keyLayoutTrack && activeClip) {
    return completeLayoutKeyframeCommit(
      nextTransforms,
      groupId,
      resolveCommitKeyframeTime(activeClip, playheadTicks, keyframeSourceTimeTicks),
      pointEpsilonTicks,
    );
  }
  return nextTransforms;
}
