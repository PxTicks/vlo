import { describe, expect, it, vi } from "vitest";
import { livePreviewParamStore } from "../../liveParams/livePreviewParamStore";
import {
  ColorGradeHistogramRuntime,
  type ColorGradeHistogramSnapshot,
} from "../histogramRuntime";

function snapshot(): ColorGradeHistogramSnapshot {
  const histogram = {
    luma: new Float32Array(),
    red: new Float32Array(),
    green: new Float32Array(),
    blue: new Float32Array(),
    hue: new Float32Array(),
  };
  return { before: histogram, after: histogram };
}

describe("ColorGradeHistogramRuntime", () => {
  it("invalidates throttling through the shared live preview stream", () => {
    const runtime = new ColorGradeHistogramRuntime();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe("live-grade", listener);
    expect(runtime.hasSubscription("live-grade")).toBe(true);
    runtime.publish("live-grade", snapshot(), 100);

    expect(runtime.getDueTransformIds(["live-grade"], 200)).toEqual([]);
    livePreviewParamStore.set("live-grade", "exposure", 1);
    expect(runtime.getDueTransformIds(["live-grade"], 200)).toEqual([
      "live-grade",
    ]);

    livePreviewParamStore.clear("live-grade", "exposure");
    unsubscribe();
    expect(runtime.hasSubscription("live-grade")).toBe(false);
    runtime.destroy();
  });
});
