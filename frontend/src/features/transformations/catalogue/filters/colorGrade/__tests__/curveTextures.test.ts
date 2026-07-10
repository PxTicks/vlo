import { afterEach, describe, expect, it, vi } from "vitest";
import { MonotoneCubicSpline } from "../../../../utils/MonotoneCubicSpline";
import {
  CURVE_TEXTURE_WIDTH,
  CurveTextureBaker,
} from "../curveTextures";

describe("CurveTextureBaker", () => {
  const bakers: CurveTextureBaker[] = [];

  afterEach(() => {
    bakers.splice(0).forEach((baker) => baker.destroy());
    vi.useRealTimers();
  });

  function createBaker(): CurveTextureBaker {
    const baker = new CurveTextureBaker();
    bakers.push(baker);
    return baker;
  }

  it("starts with identity value curves and flat modifier curves", () => {
    const baker = createBaker();
    expect(baker.hasActiveCurves).toBe(false);
    expect(baker.texture.source.autoGarbageCollect).toBe(true);
    const sample = 512;
    const x = sample / (CURVE_TEXTURE_WIDTH - 1);
    expect(baker.pixels[sample * 4]).toBeCloseTo(x, 6);
    expect(baker.pixels[sample * 4 + 1]).toBeCloseTo(x, 6);
    expect(baker.pixels[(CURVE_TEXTURE_WIDTH + sample) * 4]).toBe(0);
  });

  it("hash-guards repeated assignment and matches direct spline sampling", () => {
    const baker = createBaker();
    const points = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.2 },
      { x: 1, y: 1 },
    ];
    expect(baker.setCurve("curveMaster", points)).toBe(true);
    expect(baker.hasActiveCurves).toBe(true);
    expect(baker.setCurve("curveMaster", points.map((point) => ({ ...point })))).toBe(false);
    baker.flush();

    const sample = 700;
    const x = sample / (CURVE_TEXTURE_WIDTH - 1);
    const expected = new MonotoneCubicSpline(
      points.map((point) => ({ time: point.x, value: point.y })),
    ).at(x);
    expect(baker.pixels[sample * 4]).toBeCloseTo(expected, 5);
  });

  it("clears the active flag when a curve returns to its identity", () => {
    const baker = createBaker();
    baker.setCurve("curveHueSat", [
      { x: 0, y: 0.2 },
      { x: 1, y: 0.2 },
    ]);
    expect(baker.hasActiveCurves).toBe(true);

    baker.setCurve("curveHueSat", [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
    ]);
    expect(baker.hasActiveCurves).toBe(false);
  });

  it("coalesces rapid changes into one scheduled bake", () => {
    vi.useFakeTimers();
    const baker = createBaker();
    const first = [
      { x: 0, y: 0 },
      { x: 1, y: 0.8 },
    ];
    const latest = [
      { x: 0, y: 0.1 },
      { x: 1, y: 0.9 },
    ];
    baker.setCurve("curveR", first);
    baker.setCurve("curveR", latest);
    expect(baker.pixels[1]).toBe(0);
    vi.advanceTimersByTime(16);
    expect(baker.pixels[1]).toBeCloseTo(0.1, 6);
  });
});
