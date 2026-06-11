import { describe, it, expect } from "vitest";
import { ticksToPx, pxToTicks, ticksPerPixel, pixelsPerSecond } from "../../../../core/time/pixelGrid";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../../constants";

describe("pixelGrid (tick <-> px)", () => {
  it("matches the legacy inline formulas at zoom 1", () => {
    expect(pixelsPerSecond(1)).toBe(PIXELS_PER_SECOND);
    // 1 second of ticks -> PIXELS_PER_SECOND px
    expect(ticksToPx(TICKS_PER_SECOND, 1)).toBe(PIXELS_PER_SECOND);
    // ticksPerPixel(zoom) === TICKS_PER_SECOND / (PIXELS_PER_SECOND * zoom)
    expect(ticksPerPixel(1)).toBe(TICKS_PER_SECOND / PIXELS_PER_SECOND);
    expect(ticksPerPixel(2)).toBe(TICKS_PER_SECOND / (PIXELS_PER_SECOND * 2));
  });

  it("scales with zoom", () => {
    expect(ticksToPx(TICKS_PER_SECOND, 2)).toBe(PIXELS_PER_SECOND * 2);
    // pxToTicks is the inverse of ticksToPx
    for (const zoom of [0.25, 1, 3.5]) {
      const px = ticksToPx(TICKS_PER_SECOND, zoom);
      expect(pxToTicks(px, zoom)).toBeCloseTo(TICKS_PER_SECOND, 6);
    }
  });

  it("pxToTicks equals the old (px / (PIXELS_PER_SECOND * zoom)) * TICKS formula", () => {
    const px = 137;
    const zoom = 1.75;
    expect(pxToTicks(px, zoom)).toBeCloseTo(
      (px / (PIXELS_PER_SECOND * zoom)) * TICKS_PER_SECOND,
      6,
    );
  });

  it("guards non-positive / non-finite zoom", () => {
    expect(pixelsPerSecond(0)).toBe(PIXELS_PER_SECOND);
    expect(pixelsPerSecond(-1)).toBe(PIXELS_PER_SECOND);
    expect(pixelsPerSecond(Number.NaN)).toBe(PIXELS_PER_SECOND);
  });
});
