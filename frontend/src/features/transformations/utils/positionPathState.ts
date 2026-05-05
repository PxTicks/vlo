import type { TimelineClip } from "../../../types/TimelineTypes";
import type { PositionPathParameter, PositionTransform } from "../types";

export function getPositionTransform(
  clip: TimelineClip | null | undefined,
): PositionTransform | null {
  if (!clip || !Array.isArray(clip.transformations)) {
    return null;
  }

  const transform = clip.transformations.find(
    (candidate) => candidate.type === "position",
  );
  return (transform as PositionTransform | undefined) ?? null;
}

export function getPositionPath(
  clip: TimelineClip | null | undefined,
): PositionPathParameter | null {
  return getPositionTransform(clip)?.parameters.path ?? null;
}
