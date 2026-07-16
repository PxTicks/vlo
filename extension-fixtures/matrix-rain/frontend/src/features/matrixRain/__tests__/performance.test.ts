import { describe, expect, it } from "vitest";
import { estimateMatrixRainWorkload } from "../utils/performance";

describe("Matrix Rain workload instrumentation", () => {
  it.each([
    { width: 1280, height: 720, size: 6, verticalSpacing: 2 },
    { width: 1920, height: 1080, size: 10, verticalSpacing: 2 },
    { width: 3840, height: 2160, size: 16, verticalSpacing: 2 },
  ])(
    "keeps the state pass low resolution at $width×$height / size $size",
    (input) => {
      const estimate = estimateMatrixRainWorkload({
        ...input,
        maxHistorySeconds: 6,
        maxStepSeconds: 1 / 30,
      });

      expect(estimate.stateTexels).toBe(
        estimate.stateWidth * estimate.stateHeight,
      );
      expect(estimate.stateToFullResolutionRatio).toBeLessThan(0.03);
      expect(estimate.pingPongStateBytes).toBe(estimate.stateTexels * 8);
      expect(estimate.maximumWarmupSamples).toBe(180);
    },
  );

  it("scales linearly for two filter instances without shared state", () => {
    const one = estimateMatrixRainWorkload({
      width: 1920,
      height: 1080,
      size: 10,
      verticalSpacing: 2,
    });

    expect(one.stateTexels * 2).toBe(34_560);
    expect(one.pingPongStateBytes * 2).toBe(276_480);
  });
});
