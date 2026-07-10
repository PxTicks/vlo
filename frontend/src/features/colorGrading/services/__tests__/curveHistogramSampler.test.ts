import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractPixels = vi.fn(() => ({
  pixels: new Uint8ClampedArray([128, 128, 128, 255]),
  width: 1,
  height: 1,
}));

vi.mock("../../../../core/pixi/activeApplication", () => ({
  getActivePixiApplication: () => ({
    renderer: { extract: { pixels: extractPixels } },
  }),
  getActivePixiContentTarget: () => ({
    target: {},
    frame: { width: 1, height: 1 },
  }),
}));

import { CurveHistogramSampler } from "../curveHistogramSampler";

describe("CurveHistogramSampler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    extractPixels.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("captures one stable reference per subscribed grade", () => {
    const sampler = new CurveHistogramSampler();
    const listener = vi.fn();
    const unsubscribe = sampler.subscribe("grade-1", listener);

    expect(extractPixels).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(extractPixels).toHaveBeenCalledTimes(1);

    const secondListener = vi.fn();
    const unsubscribeSecond = sampler.subscribe("grade-1", secondListener);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(extractPixels).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribeSecond();
  });
});
