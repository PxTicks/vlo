import type { TimelineClip } from "../../../types/TimelineTypes";
import type { VolumeTransform } from "../types";
import { resolveScalar } from "./resolveScalar";

/**
 * Evaluates the volume transformation for a clip at a given time.
 * Returns the gain multiplier (1.0 = unity gain, 0.0 = silence, 2.0 = 200% boost).
 *
 * @param clip - The timeline clip containing volume transformations
 * @param localTime - Time in ticks, relative to the clip's visual start
 * @returns Gain multiplier value
 */
export function getInstantaneousVolume(
  clip: TimelineClip,
  localTime: number,
): number {
  const volumeTransform = clip.transformations?.find(
    (t) => t.type === "volume" && t.isEnabled
  ) as VolumeTransform | undefined;

  if (!volumeTransform) {
    return 1.0; // Unity gain (no volume change)
  }

  const { gain } = volumeTransform.parameters;

  // resolveScalar handles both constant numbers and splines
  return resolveScalar(gain, localTime, 1.0);
}
