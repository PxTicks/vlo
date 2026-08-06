import { mediaSecondsToTick } from "../../../core/time";

export function durationSecondsToTicks(
  durationSeconds: number | null | undefined,
): number | null {
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }

  return Math.max(0, mediaSecondsToTick(durationSeconds, "floor"));
}
