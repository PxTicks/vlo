import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { computeCommitMutation } from "./commitComputation";
import { insertTransformRespectingDefaultOrder } from "./transformOrdering";

export type LayoutCommitGroup = "position" | "scale" | "rotation";
export type LayoutCommitControl = "x" | "y" | "angle";

export interface CommitLayoutControlInput {
  clip: TimelineClip;
  transforms: ClipTransform[];
  groupId: LayoutCommitGroup;
  controlName: LayoutCommitControl;
  value: number;
  playheadTicks: number;
  pointEpsilonTicks: number;
  transformId?: string;
}

export interface CommitLayoutControlResult {
  transformId: string;
  nextTransforms: ClipTransform[];
  wasCreated: boolean;
  appendedAtEnd: boolean;
}

/**
 * Applies a single layout control commit (position/scale/rotation) to a transform
 * stack using the same commit/keyframe logic used by the transformation panel.
 *
 * This function is pure: it only computes the next transform stack and metadata.
 */
export function commitLayoutControlToTransforms({
  clip,
  transforms,
  groupId,
  controlName,
  value,
  playheadTicks,
  pointEpsilonTicks,
  transformId,
}: CommitLayoutControlInput): CommitLayoutControlResult | null {
  const commit = computeCommitMutation({
    groupId,
    controlName,
    value,
    transformId,
    transforms,
    activeClip: clip,
    playheadTicks,
    pointEpsilonTicks,
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
