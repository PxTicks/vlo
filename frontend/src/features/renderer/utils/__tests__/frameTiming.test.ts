import { describe, expect, it } from "vitest";
import { isFrameTimestampReady } from "../frameTiming";

function simulatePresentedFrames(
  frameTimestamps: number[],
  requestTimes: number[],
): number[] {
  const presentedFrames: number[] = [];
  let currentFrame = frameTimestamps[0] ?? 0;
  let nextIndex = 1;

  for (const requestTime of requestTimes) {
    while (
      nextIndex < frameTimestamps.length &&
      isFrameTimestampReady(frameTimestamps[nextIndex], requestTime)
    ) {
      currentFrame = frameTimestamps[nextIndex];
      nextIndex += 1;
    }

    presentedFrames.push(currentFrame);
  }

  return presentedFrames;
}

describe("frameTiming", () => {
  it("treats millisecond-rounded frame timestamps as ready", () => {
    expect(isFrameTimestampReady(0.063, 0.0625)).toBe(true);
    expect(isFrameTimestampReady(0.188, 0.1875)).toBe(true);
  });

  it("does not jump across real frame holds", () => {
    expect(isFrameTimestampReady(0.5, 0.49)).toBe(false);
    expect(isFrameTimestampReady(0.5, 0.45)).toBe(false);
  });

  it("prevents every-other-frame presentation drops at 16 fps", () => {
    const frameTimestamps = [0, 0.063, 0.125, 0.188, 0.25];
    const requestTimes = [0, 0.0625, 0.125, 0.1875, 0.25];

    expect(simulatePresentedFrames(frameTimestamps, requestTimes)).toEqual([
      0,
      0.063,
      0.125,
      0.188,
      0.25,
    ]);
  });
});

