import {
  getTransformInputTimeAtVisualOffset,
  mapLayerInputToVisualTime,
} from "../timeCalculation";
import type {
  TimelineClip,
  ClipTransform,
} from "../../../../types/TimelineTypes";

describe("mapLayerInputToVisualTime", () => {
  const baseClip: TimelineClip = {
    id: "clip-1",
    assetId: "asset-1",
    name: "Test Clip",
    trackId: "track-1",
    start: 0,
    croppedSourceDuration: 1000,
    timelineDuration: 1000,
    sourceDuration: 1000,
    transformedDuration: 1000,
    transformedOffset: 0,
    offset: 0,
    type: "video",
    transformations: [],
  };

  it("should map time 1:1 when no transformations exist", () => {
    const result = mapLayerInputToVisualTime(baseClip, "unknown", 500);
    // Should be Visual Time (500) - StartCrop (0) = 500
    expect(result).toBe(500);
  });

  it("should account for transformedOffset", () => {
    const clip = { ...baseClip, transformedOffset: 200 };
    const result = mapLayerInputToVisualTime(clip, "unknown", 500);
    // Absolute Visual is 500.
    // Visual Offset = 500 - 200 = 300.
    expect(result).toBe(300);
  });

  it("should map through a speed transform (2x speed)", () => {
    // Speed 2x means: Source Time T -> Visual Time T/2
    // We are mapping Layer Input (Source) -> Visual

    const speedTransform: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };

    const clip = { ...baseClip, transformations: [speedTransform] };

    // Input Time (Source) = 1000
    // Visual Time should be 1000 / 2 = 500
    const result = mapLayerInputToVisualTime(clip, "speed-1", 1000);

    expect(result).toBe(500);
  });

  it("should map through a speed transform (0.5x speed / slow motion)", () => {
    // Speed 0.5x means: Source Time T -> Visual Time T/0.5 = T*2

    const speedTransform: ClipTransform = {
      id: "speed-slow",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 0.5 },
    };

    const clip = { ...baseClip, transformations: [speedTransform] };

    // Input Time (Source) = 500
    // Visual Time should be 500 / 0.5 = 1000
    const result = mapLayerInputToVisualTime(clip, "speed-slow", 500);

    expect(result).toBe(1000);
  });

  it("should map correctly when transformId matches index (Mapping Input of Transform)", () => {
    // mapLayerInputToVisualTime takes the transformId of the layer whose INPUT domain we are in.
    // So if we pass "speed-1", we are saying "Here is a time at the INPUT of speed-1".
    // We want to push it through speed-1 and everything downstream.

    const speedTransform: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };

    const clip = { ...baseClip, transformations: [speedTransform] };

    // Input to Speed-1 is Source Time 1000.
    // It goes through Speed-1 ( /2 ) -> 500.
    const result = mapLayerInputToVisualTime(clip, "speed-1", 1000);
    expect(result).toBe(500);
  });

  it("should handle transform not found (assume source/start)", () => {
    // If ID not found, it defaults to index 0 (Source)
    const speedTransform: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };

    const clip = { ...baseClip, transformations: [speedTransform] };
    const result = mapLayerInputToVisualTime(clip, "non-existent-id", 1000);
    // Should treat 1000 as Source Input, push through Speed-1 -> 500
    expect(result).toBe(500);
  });
});

describe("getTransformInputTimeAtVisualOffset", () => {
  const baseClip: TimelineClip = {
    id: "clip-2",
    assetId: "asset-1",
    name: "Test Clip 2",
    trackId: "track-1",
    start: 100,
    croppedSourceDuration: 1000,
    timelineDuration: 1000,
    sourceDuration: 1000,
    transformedDuration: 1000,
    transformedOffset: 20,
    offset: 0,
    type: "video",
    transformations: [],
  };

  it("returns visual local time + transformedOffset when transform id is missing", () => {
    const result = getTransformInputTimeAtVisualOffset(
      baseClip,
      "missing",
      200,
    );

    expect(result).toBe(220);
  });

  it("matches backward propagation through downstream scalar speed transforms", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformedOffset: 0,
      transformations: [
        {
          id: "position-1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
        },
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "speed-2",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 0.5 },
        },
      ],
    };

    // localVisualTime = 100
    // downstream speed-2 applies first (100 * 0.5 = 50)
    // downstream speed-1 applies next (50 * 2 = 100)
    // target position-1 should therefore see 100
    const result = getTransformInputTimeAtVisualOffset(
      clip,
      "position-1",
      100,
    );

    expect(result).toBe(100);
  });

  it("does not include the target speed transform itself", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformedOffset: 0,
      transformations: [
        {
          id: "speed-target",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 3 },
        },
        {
          id: "speed-downstream",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
    };

    // Target is index 0, so only index 1 is applied during backward pull:
    // 40 * 2 = 80
    const result = getTransformInputTimeAtVisualOffset(
      clip,
      "speed-target",
      40,
    );

    expect(result).toBe(80);
  });
});
