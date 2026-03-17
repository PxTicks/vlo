import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { commitLayoutControlToTransforms } from "../../../transformations";

export interface TransformCommitActions {
  addClipTransform: (clipId: string, effect: ClipTransform) => void;
  setClipTransforms: (clipId: string, transforms: ClipTransform[]) => void;
  updateClipTransform: (
    clipId: string,
    effectId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
}

export interface CommitTransformControlInput {
  clip: TimelineClip;
  transforms: ClipTransform[];
  groupId: "position" | "scale" | "rotation";
  controlName: "x" | "y" | "angle";
  value: number;
  playheadTicks: number;
  pointEpsilonTicks: number;
  actions: TransformCommitActions;
  transformId?: string;
}

export interface CommitTransformControlResult {
  transformId: string;
  nextTransforms: ClipTransform[];
}

export function commitTransformControl({
  clip,
  transforms,
  groupId,
  controlName,
  value,
  playheadTicks,
  pointEpsilonTicks,
  actions,
  transformId,
}: CommitTransformControlInput): CommitTransformControlResult | null {
  const result = commitLayoutControlToTransforms({
    clip,
    transforms,
    groupId,
    controlName,
    value,
    playheadTicks,
    pointEpsilonTicks,
    transformId,
  });
  if (!result) return null;

  if (!result.wasCreated) {
    const committedTransform = result.nextTransforms.find(
      (transform) => transform.id === result.transformId,
    );
    if (!committedTransform) return null;

    actions.updateClipTransform(clip.id, result.transformId, {
      parameters: committedTransform.parameters,
      ...(committedTransform.keyframeTimes !== undefined
        ? { keyframeTimes: committedTransform.keyframeTimes }
        : {}),
    });
  } else if (result.appendedAtEnd) {
    const committedTransform = result.nextTransforms[result.nextTransforms.length - 1];
    if (!committedTransform) return null;
    actions.addClipTransform(clip.id, committedTransform);
  } else {
    actions.setClipTransforms(clip.id, result.nextTransforms);
  }

  return { transformId: result.transformId, nextTransforms: result.nextTransforms };
}

export function hasDragMovement(epsilon: number, ...deltas: number[]): boolean {
  return deltas.some((delta) => Math.abs(delta) > epsilon);
}
