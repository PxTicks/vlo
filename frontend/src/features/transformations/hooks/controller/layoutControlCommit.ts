import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { computeCommitMutation, resolveCommitKeyframeTime } from "./commitComputation";
import { insertTransformRespectingDefaultOrder } from "./transformOrdering";
import {
  completeLayoutKeyframeCommit,
  isLayoutKeyframeTransform,
  prepareLayoutKeyframeCommit,
} from "../../utils/layoutKeyframeGroup";

export type LayoutCommitGroup = "position" | "scale" | "rotation";
export type LayoutCommitControl = "x" | "y" | "angle";

export interface CommitLayoutControlInput {
  clip: TimelineClip;
  transforms: ClipTransform[];
  groupId: LayoutCommitGroup;
  /** Usually x / y / angle; the panel also commits non-keyframed layout
   *  controls (e.g. scale's `isLinked`) through here. */
  controlName: LayoutCommitControl | (string & {});
  value: unknown;
  playheadTicks: number;
  pointEpsilonTicks: number;
  transformId?: string;
  /**
   * Adjustment-aware source-media time (project ticks) for the committed
   * keyframe. Forwarded to `computeCommitMutation`; when omitted the keyframe
   * time is derived from `playheadTicks`, correct only with no adjustment
   * retiming over the clip.
   */
  keyframeSourceTimeTicks?: number;
  applyLinkedControls?: boolean;
}

export interface CommitLayoutControlResult {
  transformId: string;
  nextTransforms: ClipTransform[];
  wasCreated: boolean;
  appendedAtEnd: boolean;
  /**
   * Transforms other than the committed one changed (the shared layout
   * keyframe track added or materialized keys), so callers must write the
   * whole `nextTransforms` stack rather than the single committed transform.
   */
  changedOtherTransforms: boolean;
}

/**
 * Applies a single layout control commit (position/scale/rotation) to a transform
 * stack using the same commit/keyframe logic used by the transformation panel.
 *
 * Position, scale and rotation share one keyframe track: while it has keys, the
 * commit keys every layout transform at the playhead (see layoutKeyframeGroup).
 *
 * This function is pure: it only computes the next transform stack and metadata.
 */
export function commitLayoutControlToTransforms(
  input: CommitLayoutControlInput,
): CommitLayoutControlResult | null {
  // Only numeric values are keyframed; other controls never touch the track.
  if (typeof input.value !== "number") {
    const result = commitSingleLayoutControl(input);
    return result ? { ...result, changedOtherTransforms: false } : null;
  }

  const prepared = prepareLayoutKeyframeCommit(
    input.transforms,
    input.groupId,
    input.transformId,
    input.pointEpsilonTicks,
  );
  const result = commitSingleLayoutControl({ ...input, transforms: prepared });
  if (!result) return null;
  const committed = result.nextTransforms.find(
    (transform) => transform.id === result.transformId,
  );
  if (!committed || !isLayoutKeyframeTransform(committed)) {
    return { ...result, changedOtherTransforms: prepared !== input.transforms };
  }

  const nextTransforms = completeLayoutKeyframeCommit(
    result.nextTransforms,
    input.groupId,
    resolveCommitKeyframeTime(
      input.clip,
      input.playheadTicks,
      input.keyframeSourceTimeTicks,
    ),
    input.pointEpsilonTicks,
  );
  return {
    ...result,
    nextTransforms,
    changedOtherTransforms:
      prepared !== input.transforms || nextTransforms !== result.nextTransforms,
  };
}

function commitSingleLayoutControl({
  clip,
  transforms,
  groupId,
  controlName,
  value,
  playheadTicks,
  pointEpsilonTicks,
  transformId,
  keyframeSourceTimeTicks,
  applyLinkedControls,
}: CommitLayoutControlInput): Omit<
  CommitLayoutControlResult,
  "changedOtherTransforms"
> | null {
  const commit = computeCommitMutation({
    groupId,
    controlName,
    value,
    transformId,
    transforms,
    activeClip: clip,
    playheadTicks,
    pointEpsilonTicks,
    keyframeSourceTimeTicks,
    applyLinkedControls,
  });

  if (commit.mode === "update") {
    const updates: Partial<Omit<ClipTransform, "id" | "type">> = {
      parameters: commit.parameters,
      ...(commit.keyframeTimes !== undefined
        ? { keyframeTimes: commit.keyframeTimes }
        : {}),
    };

    const nextTransforms = transforms.map((transform) =>
      transform.id === commit.existingTransform.id
        ? { ...transform, ...updates }
        : transform,
    );

    return {
      transformId: commit.existingTransform.id,
      nextTransforms,
      wasCreated: false,
      appendedAtEnd: false,
    };
  }

  const nextTransforms = insertTransformRespectingDefaultOrder(
    transforms,
    commit.createdTransform,
  );
  const appendedAtEnd =
    nextTransforms[nextTransforms.length - 1]?.id === commit.createdTransform.id;

  return {
    transformId: commit.createdTransform.id,
    nextTransforms,
    wasCreated: true,
    appendedAtEnd,
  };
}
