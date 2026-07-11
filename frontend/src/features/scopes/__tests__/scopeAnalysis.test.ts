import { describe, expect, it } from "vitest";
import { analyzeScopePixels, HISTOGRAM_BINS } from "../scopeAnalysis";

describe("scope analysis", () => {
  it("accumulates all four scopes from premultiplied pixels", () => {
    const snapshot = analyzeScopePixels(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 0, 128]),
      2,
      1,
      123,
    );
    expect(snapshot.histogram[0]).toHaveLength(HISTOGRAM_BINS);
    expect(snapshot.histogram[0][255]).toBeGreaterThan(0);
    expect(snapshot.histogram[1][255]).toBeGreaterThan(0);
    expect(Math.max(...snapshot.waveform)).toBe(1);
    expect(Math.max(...snapshot.parade)).toBe(1);
    expect(Math.max(...snapshot.vectorscope)).toBe(1);
    expect(snapshot.sampledAt).toBe(123);
  });

  it("ignores fully transparent samples", () => {
    const snapshot = analyzeScopePixels(new Uint8Array([255, 255, 255, 0]), 1, 1);
    expect(Math.max(...snapshot.histogram[3])).toBe(0);
  });
});
