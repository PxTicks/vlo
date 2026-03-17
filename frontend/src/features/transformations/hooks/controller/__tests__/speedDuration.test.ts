import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../../timeline";
import {
  computeSpeedShapeUpdate,
  computeSpeedShapeUpdateForTransforms,
} from "../speedDuration";

function createClip(
  overrides: Partial<TimelineClip>,
  transformations: TimelineClip["transformations"],
): TimelineClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    type: "video" as const,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    name: "Speed Clip",
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    transformations,
    ...overrides,
  } as TimelineClip;
}

describe("computeSpeedShapeUpdate", () => {
  it("returns timeline and transformed duration updates for non-image clips", () => {
    const speedTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 1 },
    };
    const clip = createClip({}, [speedTransform]);

    const result = computeSpeedShapeUpdate({
      groupId: "speed",
      controlName: "factor",
      clip,
      existingTransform: speedTransform,
      parameters: { factor: 2 },
    });

    expect(result).not.toBeNull();
    expect(result?.timelineDuration).toBeGreaterThan(0);
    expect(result?.timelineDuration).toBeLessThan(clip.timelineDuration);
    expect(result?.transformedDuration).toBeDefined();
  });

  it("omits transformedDuration for image clips", () => {
    const clip = createClip(
      {
        type: "image",
        sourceDuration: null,
      },
      [],
    );

    const result = computeSpeedShapeUpdate({
      groupId: "speed",
      controlName: "factor",
      clip,
      existingTransform: undefined,
      parameters: { factor: 2 },
    });

    expect(result).not.toBeNull();
    expect(result?.timelineDuration).toBeGreaterThan(0);
    expect(result?.transformedDuration).toBeUndefined();
  });

  it("returns null for non-speed commits", () => {
    const clip = createClip({}, []);
    const result = computeSpeedShapeUpdate({
      groupId: "position",
      controlName: "x",
      clip,
      parameters: { x: 10 },
    });

    expect(result).toBeNull();
  });

  it("recomputes duration when toggling speed off", () => {
    const speedTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };
    const clip = createClip(
      {
        timelineDuration: 5 * TICKS_PER_SECOND,
        croppedSourceDuration: 10 * TICKS_PER_SECOND,
      },
      [speedTransform],
    );

    const result = computeSpeedShapeUpdateForTransforms({
      clip,
      nextTransforms: [{ ...speedTransform, isEnabled: false }],
    });

    expect(result).not.toBeNull();
    expect(result?.timelineDuration).toBeGreaterThan(clip.timelineDuration);
  });
});
