import { describe, it, expect, beforeEach } from "vitest";
import { Sprite, Texture } from "pixi.js";
import { applyClipTransforms } from "../applyTransformations";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { liveParamStore } from "../services/liveParamStore";
import { livePreviewParamStore } from "../services/livePreviewParamStore";
import { resolveScalar } from "../utils/resolveScalar";
import { getIdempotentTimeMap } from "../utils/timeCalculation";

// Mock Pixi basics
// We need a real-ish Sprite/Texture to test property mutations
describe("applyClipTransforms", () => {
  let mockSprite: Sprite;
  let mockClip: TimelineClip;
  const containerSize = { width: 1920, height: 1080 };

  beforeEach(() => {
    mockSprite = new Sprite();
    // Mock texture dimensions
    mockSprite.texture = {
      valid: true,
      width: 1920, // Same same
      height: 1080,
    } as unknown as Texture;

    // Reset properties
    mockSprite.position.set(0, 0);
    mockSprite.scale.set(1, 1);
    mockSprite.rotation = 0;
    mockSprite.alpha = 1;
    livePreviewParamStore.clearAll();

    mockClip = {
      id: "c1",
      type: "video",
      name: "Clip 1",
      sourceDuration: 100,
      timelineDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "t1",
      start: 0,
      transformedDuration: 100,
      transformedOffset: 0,
      croppedSourceDuration: 100, // Add croppedSourceDuration
    };
  });

  it("applies base layout (CONTAIN) when no effects match", () => {
    // 1. Exact Match Aspect Ratio
    applyClipTransforms(mockSprite, mockClip, containerSize);
    expect(mockSprite.scale.x).toBe(1);
    expect(mockSprite.scale.y).toBe(1);
    expect(mockSprite.position.x).toBe(960); // 1920 / 2
    expect(mockSprite.position.y).toBe(540); // 1080 / 2

    // 2. Different Aspect Ratio (Texture is wider)
    mockSprite.texture = {
      valid: true,
      width: 3840,
      height: 1080,
    } as unknown as Texture;
    // Container is 1920 wide. Scale should be 0.5 to fit width.
    applyClipTransforms(mockSprite, mockClip, containerSize);
    expect(mockSprite.scale.x).toBe(0.5);
    expect(mockSprite.scale.y).toBe(0.5);
  });

  it("applies rotation", () => {
    mockClip.transformations = [
      {
        id: "e1",
        type: "rotation",
        isEnabled: true,
        parameters: { angle: Math.PI / 2 }, // 90 deg
      },
    ];

    applyClipTransforms(mockSprite, mockClip, containerSize);
    expect(mockSprite.rotation).toBe(Math.PI / 2);
  });

  // Opacity Removed

  it("applies scaling correctly on top of base fit", () => {
    // Texture 1920x1080 matches container 1920x1080 -> Base Scale 1
    mockClip.transformations = [
      {
        id: "e1",
        type: "scale",
        isEnabled: true,
        parameters: { x: 2, y: 0.5 },
      },
    ];

    applyClipTransforms(mockSprite, mockClip, containerSize);
    expect(mockSprite.scale.x).toBe(2); // 1 * 2
    expect(mockSprite.scale.y).toBe(0.5); // 1 * 0.5
  });

  it("applies position offsets", () => {
    mockClip.transformations = [
      {
        id: "e1",
        type: "position",
        isEnabled: true,
        parameters: { x: 100, y: -50 },
      },
    ];

    applyClipTransforms(mockSprite, mockClip, containerSize);
    expect(mockSprite.position.x).toBe(960 + 100);
    expect(mockSprite.position.y).toBe(540 - 50);
  });

  it("can disable contain base layout and use origin defaults", () => {
    mockSprite.texture = {
      valid: true,
      width: 3840,
      height: 1080,
    } as unknown as Texture;

    applyClipTransforms(
      mockSprite,
      mockClip,
      containerSize,
      undefined,
      undefined,
      { baseLayoutMode: "origin" },
    );

    expect(mockSprite.scale.x).toBe(1);
    expect(mockSprite.scale.y).toBe(1);
    expect(mockSprite.position.x).toBe(0);
    expect(mockSprite.position.y).toBe(0);
  });

  it("publishes live speed factor using timeline-mapped sampling time", () => {
    const factorSpline = {
      type: "spline" as const,
      points: [
        { time: 0, value: 1 },
        { time: 100, value: 3 },
      ],
    };

    mockClip.transformations = [
      {
        id: "speed-1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: factorSpline },
      },
    ];

    let publishedValue: number | null = null;
    const unsubscribe = liveParamStore.subscribe("speed-1", "factor", (value) => {
      publishedValue = value;
    });

    applyClipTransforms(mockSprite, mockClip, containerSize, 40);
    unsubscribe();

    const mappedInputTime = getIdempotentTimeMap(factorSpline, 40);
    const expected = resolveScalar(factorSpline, mappedInputTime, 1);

    expect(publishedValue).not.toBeNull();
    expect(publishedValue!).toBeCloseTo(expected, 3);
  });

  it("applies transient preview overrides without mutating the clip model", () => {
    mockClip.transformations = [
      {
        id: "position-1",
        type: "position",
        isEnabled: true,
        parameters: { x: 100, y: -50 },
      },
    ];

    livePreviewParamStore.set("position-1", "x", 240);

    applyClipTransforms(mockSprite, mockClip, containerSize);

    expect(mockSprite.position.x).toBe(960 + 240);
    expect(mockSprite.position.y).toBe(540 - 50);
    expect(
      (mockClip.transformations[0].parameters as { x: number }).x,
    ).toBe(100);
  });
});
