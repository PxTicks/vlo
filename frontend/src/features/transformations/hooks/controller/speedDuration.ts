import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import type { AnyTransform } from "../../types";
import {
  pushTimeThroughTransforms,
} from "../../utils/timeCalculation";
import { isDefaultTransform } from "../../catalogue/TransformationRegistry";

export interface SpeedShapeUpdateInput {
  groupId: string;
  controlName: string;
  clip?: TimelineClip;
  existingTransform?: ClipTransform;
  parameters: Record<string, unknown>;
}

export interface SpeedShapeUpdateResult {
  timelineDuration: number;
  transformedDuration?: number;
  transformedOffset?: number;
}

export interface SpeedShapeUpdateForTransformsInput {
  clip?: TimelineClip;
  nextTransforms: ClipTransform[];
}

export function computeSpeedShapeUpdateForTransforms({
  clip,
  nextTransforms,
}: SpeedShapeUpdateForTransformsInput): SpeedShapeUpdateResult | null {
  if (!clip) {
    return null;
  }

  // Preserve the current source window as the ground truth when time-remapping
  // changes. That keeps an existing trim anchored instead of reapplying speed
  // from source zero.
  const visibleSourceStart = Math.max(0, Math.round(clip.offset));
  const visibleSourceDuration = Math.max(
    0,
    Math.round(clip.croppedSourceDuration),
  );
  const visibleSourceEnd = visibleSourceStart + visibleSourceDuration;

  const transformedOffset = pushTimeThroughTransforms(
    nextTransforms,
    visibleSourceStart,
  );
  const transformedVisibleEnd = pushTimeThroughTransforms(
    nextTransforms,
    visibleSourceEnd,
  );
  const timelineDuration = Math.max(
    0,
    transformedVisibleEnd - transformedOffset,
  );
  const fullSourceTicks =
    clip.type === "image"
      ? null
      : Math.max(
          visibleSourceEnd,
          clip.sourceDuration ?? clip.timelineDuration,
        );

  const shapeUpdates: SpeedShapeUpdateResult = {
    timelineDuration,
    transformedOffset,
  };
  if (fullSourceTicks !== null) {
    shapeUpdates.transformedDuration = Math.max(
      0,
      pushTimeThroughTransforms(nextTransforms, fullSourceTicks),
    );
  }

  return shapeUpdates;
}

export function computeSpeedShapeUpdate({
  groupId,
  controlName,
  clip,
  existingTransform,
  parameters,
}: SpeedShapeUpdateInput): SpeedShapeUpdateResult | null {
  if (groupId !== "speed" || controlName !== "factor" || !clip) {
    return null;
  }

  let nextTransforms = [...(clip.transformations || [])];

  if (existingTransform) {
    nextTransforms = nextTransforms.map((transform) =>
      transform.id === existingTransform.id
        ? { ...transform, parameters }
        : transform,
    );
  } else {
    const tempSpeedTransform: AnyTransform = {
      id: "temp-calc-id",
      type: "speed",
      isEnabled: true,
      parameters,
    } as AnyTransform;

    const firstDynamicIndex = nextTransforms.findIndex(
      (transform) => !isDefaultTransform(transform.type),
    );
    if (firstDynamicIndex !== -1) {
      nextTransforms.splice(firstDynamicIndex, 0, tempSpeedTransform);
    } else {
      nextTransforms.push(tempSpeedTransform);
    }
  }

  return computeSpeedShapeUpdateForTransforms({ clip, nextTransforms });
}
