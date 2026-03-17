
import type { TimelineClip, ClipTransform } from "../../../types/TimelineTypes";

/**
 * Extracts the playback speed factor from a list of transformations.
 * Returns 1.0 if no speed transformation is present or enabled.
 * Clamped to a minimum of 0.01 to prevent division by zero or negative durations.
 * 
 * TODO: Support variable speed splines. Currently only handles constant factor.
 */
export function getSpeedFromTransforms(transforms: ClipTransform[]): number {
  const speedTransform = transforms.find((t) => t.type === "speed");
  if (!speedTransform || !speedTransform.isEnabled) return 1.0;
  
  const factor = speedTransform.parameters["factor"];
  if (typeof factor === "number") {
    return Math.max(0.01, factor);
  }
  
  // Fallback for splines/other types until fully supported
  return 1.0;
}

/**
 * Extracts the playback speed factor from a clip's transformations.
 */
export function getClipSpeed(clip: TimelineClip): number {
  return getSpeedFromTransforms(clip.transformations);
}

