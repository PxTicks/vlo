import { describe, it, expect } from "vitest";
import { Sprite } from "pixi.js";
import { applyClipTransforms } from "../applyTransformations";
import {
  getLayerInputDomain,
  solveTimelineDuration,
} from "../utils/timeCalculation";
import { TICKS_PER_SECOND } from "../../timeline";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { GenericFilterTransform } from "../types";
import { HslAdjustmentFilter } from "pixi-filters";

describe("Integration: Transforms on Cropped Clips", () => {
  // Shared constants & Setup Helper
  const T = TICKS_PER_SECOND;

  function createTestClipWithSplines(): {
    clip: TimelineClip;
    speedDomain: { minTime: number; maxTime: number };
    posDomain: { minTime: number; maxTime: number };
  } {
    // 1. Define Base Clip State (No Transforms)
    const originalSourceDuration = 10 * T;
    const cropStart = 2 * T;
    const cropEnd = 2 * T;

    const visibleDuration = originalSourceDuration - cropStart - cropEnd; // 6s
    const offset = cropStart; // 2s

    const clip: TimelineClip = {
      id: "integration-clip",
      type: "video",
      name: "Test Clip",
      trackId: "track-1",
      start: 0,
      sourceDuration: originalSourceDuration,
      timelineDuration: visibleDuration,
      offset: offset,
      transformedDuration: visibleDuration,
      transformedOffset: offset,
      croppedSourceDuration: visibleDuration,
      transformations: [],
    };

    // 2. Add Speed Transform (Index 0)
    const speedDomain = getLayerInputDomain(clip, 0);

    const speedSplinePoints = [
      { time: speedDomain.minTime, value: 1 },
      { time: speedDomain.minTime + speedDomain.duration / 2, value: 1 },
      { time: speedDomain.minTime + speedDomain.duration, value: 1 },
    ];

    clip.transformations.push({
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: {
        factor: {
          type: "spline",
          points: speedSplinePoints,
        },
      },
    });

    // 3. Add Position Transform (Index 1)
    const posDomain = getLayerInputDomain(clip, 1);

    const xSplinePoints = [
      { time: posDomain.minTime, value: 0 },
      { time: posDomain.minTime + posDomain.duration / 2, value: 300 },
      { time: posDomain.minTime + posDomain.duration, value: 0 },
    ];

    clip.transformations.push({
      id: "pos-1",
      type: "position",
      isEnabled: true,
      parameters: {
        x: {
          type: "spline",
          points: xSplinePoints,
        },
        y: 0,
      },
    });

    // 4. Add Hue Transform (Index 2)
    const hueDomain = getLayerInputDomain(clip, 2);

    const hueSplinePoints = [
      { time: hueDomain.minTime, value: 0 },
      { time: hueDomain.minTime + hueDomain.duration / 2, value: 180 },
      { time: hueDomain.minTime + hueDomain.duration, value: 0 },
    ];

    clip.transformations.push({
      id: "hue-1",
      type: "filter",
      filterName: "HslAdjustmentFilter",
      isEnabled: true,
      parameters: {
        hue: {
          type: "spline",
          points: hueSplinePoints,
        },
        saturation: 0,
        lightness: 0,
        alpha: 1,
      },
    } as GenericFilterTransform);

    return {
      clip,
      speedDomain: {
        minTime: speedDomain.minTime,
        maxTime: speedDomain.maxTime,
      },
      posDomain: { minTime: posDomain.minTime, maxTime: posDomain.maxTime },
    };
  }

  it("should correctly apply splines (Speed, Position, Hue) relative to source time on a cropped clip", () => {
    const { clip, speedDomain, posDomain } = createTestClipWithSplines();

    // Assertions
    const sprite = new Sprite();
    sprite.texture = {
      width: 100,
      height: 100,
    } as unknown as import("pixi.js").Texture;
    const containerSize = { width: 1920, height: 1080 };
    const expectedCenterX = 1920 / 2;
    const visibleDuration = clip.timelineDuration;

    // --- CHECK 1: Start (Visual t=0) ---
    sprite.position.set(0, 0);
    sprite.filters = [];
    applyClipTransforms(sprite, clip, containerSize, 0);

    expect(sprite.position.x).toBe(expectedCenterX + 0);
    if (sprite.filters && sprite.filters.length > 0) {
      expect((sprite.filters[0] as HslAdjustmentFilter).hue).toBe(0);
    }

    // --- CHECK 2: End (Visual t=6s) ---
    sprite.position.set(0, 0);
    applyClipTransforms(sprite, clip, containerSize, visibleDuration);

    expect(sprite.position.x).toBe(expectedCenterX + 0);
    if (sprite.filters && sprite.filters.length > 0) {
      expect((sprite.filters[0] as HslAdjustmentFilter).hue).toBe(0);
    }

    // --- CHECK 3: Midpoint (Visual t=3s) ---
    sprite.position.set(0, 0);
    applyClipTransforms(sprite, clip, containerSize, 3 * T);

    expect(sprite.position.x).toBeCloseTo(expectedCenterX + 300, 1);
    if (sprite.filters && sprite.filters.length > 0) {
      expect((sprite.filters[0] as HslAdjustmentFilter).hue).toBeCloseTo(
        180,
        1,
      );
    }

    // --- CHECK 4: Domain Correctness ---
    expect(speedDomain.minTime).toBeCloseTo(2 * T);
    expect(speedDomain.maxTime).toBeCloseTo(8 * T);
    expect(posDomain.minTime).toBeCloseTo(2 * T);
    expect(posDomain.maxTime).toBeCloseTo(8 * T);
  });

  it("should preserve duration when applying an identity speed spline", () => {
    const { clip } = createTestClipWithSplines();
    const visibleDuration = clip.timelineDuration;

    // 1. Calculate Visual Duration BEFORE adding new transform
    const durationBefore = solveTimelineDuration(
      clip,
      0,
      clip.croppedSourceDuration,
    );
    // Should be close to 6s
    expect(durationBefore).toBeCloseTo(visibleDuration, 1);

    // 2. Add Identity Speed Transform (Index 3)
    const identitySpeedDomain = getLayerInputDomain(clip, 3);

    const identityPoints = [
      { time: identitySpeedDomain.minTime, value: 1 },
      {
        time: identitySpeedDomain.minTime + identitySpeedDomain.duration,
        value: 1,
      },
    ];

    clip.transformations.push({
      id: "speed-2-identity",
      type: "speed",
      isEnabled: true,
      parameters: {
        factor: {
          type: "spline",
          points: identityPoints,
        },
      },
    });

    // 3. Calculate Visual Duration AFTER
    const durationAfter = solveTimelineDuration(
      clip,
      0,
      clip.croppedSourceDuration,
    );

    // 4. Assert
    expect(durationAfter).toBeCloseTo(durationBefore, 1);
  });
});
