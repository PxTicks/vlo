import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { SpeedTransform } from "../../../transformations";
import {
  resolveClipRenderTime,
  resolveClipRenderTimeFromEffectiveTick,
} from "../clipRenderTime";

function buildClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  const duration = 10 * TICKS_PER_SECOND;
  return {
    id: "clip-1",
    name: "Clip 1",
    assetId: "asset-1",
    type: "video",
    trackId: "track-1",
    start: 5 * TICKS_PER_SECOND,
    timelineDuration: duration,
    sourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    offset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function speedTransform(factor: number): SpeedTransform {
  return {
    id: "speed-1",
    type: "speed",
    isEnabled: true,
    parameters: { factor },
  } as SpeedTransform;
}

describe("resolveClipRenderTime", () => {
  it("names the visual and source domains for an unmodified clip", () => {
    const clip = buildClip();
    const resolved = resolveClipRenderTimeFromEffectiveTick({
      clip,
      effectiveTrackTick: clip.start + TICKS_PER_SECOND,
    });

    expect(resolved.clipVisualTimeTicks).toBe(TICKS_PER_SECOND);
    expect(resolved.sourceTimeTicks).toBe(TICKS_PER_SECOND);
    expect(resolved.sourceTimeSeconds).toBe(1);
  });

  it("includes crop offset in source time while keeping visual time local", () => {
    const clip = buildClip({ transformedOffset: 2 * TICKS_PER_SECOND });
    const resolved = resolveClipRenderTimeFromEffectiveTick({
      clip,
      effectiveTrackTick: clip.start + TICKS_PER_SECOND,
    });

    expect(resolved.clipVisualTimeTicks).toBe(TICKS_PER_SECOND);
    expect(resolved.sourceTimeTicks).toBe(3 * TICKS_PER_SECOND);
  });

  it("pulls visual time through speed before exposing source time", () => {
    const clip = buildClip({ transformations: [speedTransform(2)] });
    const resolved = resolveClipRenderTimeFromEffectiveTick({
      clip,
      effectiveTrackTick: clip.start + TICKS_PER_SECOND,
    });

    expect(resolved.clipVisualTimeTicks).toBe(TICKS_PER_SECOND);
    expect(resolved.sourceTimeTicks).toBe(2 * TICKS_PER_SECOND);
  });

  it("applies adjustment timing once through the supplied presentation lookup", () => {
    const clip = buildClip();
    const resolved = resolveClipRenderTime({
      clip,
      presentationTick: 10 * TICKS_PER_SECOND,
      resolveEffectiveTrackTick: () => clip.start + 3 * TICKS_PER_SECOND,
    });

    expect(resolved.presentationTick).toBe(10 * TICKS_PER_SECOND);
    expect(resolved.effectiveTrackTick).toBe(clip.start + 3 * TICKS_PER_SECOND);
    expect(resolved.clipVisualTimeTicks).toBe(3 * TICKS_PER_SECOND);
    expect(resolved.sourceTimeTicks).toBe(3 * TICKS_PER_SECOND);
  });
});
