import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import type { AnyTransform } from "../../types";
import {
  getSegmentContentDuration,
  solveTimelineDuration,
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

  const currentContentTicks = getSegmentContentDuration(
    clip,
    0,
    clip.timelineDuration,
  );

  const tempClip = { ...clip, transformations: nextTransforms };
  const timelineDuration = solveTimelineDuration(tempClip, 0, currentContentTicks);
  const fullSourceTicks =
    clip.type === "image"
      ? null
      : (clip.sourceDuration ?? clip.timelineDuration);

  const shapeUpdates: SpeedShapeUpdateResult = { timelineDuration };
  if (fullSourceTicks !== null) {
    shapeUpdates.transformedDuration = solveTimelineDuration(
      tempClip,
      0,
      fullSourceTicks,
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
