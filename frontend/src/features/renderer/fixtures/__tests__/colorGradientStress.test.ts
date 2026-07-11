import { describe, expect, it } from "vitest";
import {
  createGradientStressFixture,
  measureGradientBanding,
} from "../colorGradientStress";

describe("gradient stress fixture", () => {
  it("measures the precision and dither improvements", () => {
    const metrics = measureGradientBanding(createGradientStressFixture());
    expect(metrics.float16IntermediateLevels).toBeGreaterThan(
      metrics.eightBitIntermediateLevels * 8,
    );
    expect(metrics.ditheredOutputLevels).toBeGreaterThan(
      metrics.eightBitOutputLevels,
    );
  });
});
