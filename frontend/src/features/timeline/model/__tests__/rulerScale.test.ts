import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import { getTicksPerFrame } from "../../../../core/time/ticksPerFrame";
import { chooseRulerScale, formatRulerLabel } from "../rulerScale";

const FPS = 24;
const FRAME = getTicksPerFrame(FPS);

describe("chooseRulerScale", () => {
  it("gets finer as pixels-per-second grows, monotonically", () => {
    let previous = Infinity;
    for (let pps = 10; pps <= 2000; pps += 10) {
      const { gradationTicks } = chooseRulerScale(pps, FPS);
      expect(gradationTicks).toBeLessThanOrEqual(previous);
      previous = gradationTicks;
    }
  });

  it("never goes finer than a single frame", () => {
    for (const pps of [2000, 20000, 1e6]) {
      expect(chooseRulerScale(pps, FPS).gradationTicks).toBe(FRAME);
    }
  });

  it("labels every second frame at the finest level", () => {
    const scale = chooseRulerScale(2000, FPS);
    expect(scale).toEqual({
      gradationTicks: FRAME,
      labelTicks: 2 * FRAME,
      frameLabels: true,
    });
  });

  it("always leaves unlabelled gradations between labels", () => {
    for (let pps = 10; pps <= 2000; pps += 10) {
      const { gradationTicks, labelTicks } = chooseRulerScale(pps, FPS);
      expect(labelTicks).toBeGreaterThan(gradationTicks);
      expect(labelTicks % gradationTicks).toBeCloseTo(0, 6);
    }
  });

  it("keeps whole seconds on the gradation grid at every zoom", () => {
    for (let pps = 10; pps <= 2000; pps += 10) {
      const { gradationTicks, labelTicks } = chooseRulerScale(pps, FPS);
      const step = gradationTicks < TICKS_PER_SECOND ? gradationTicks : null;
      if (step) expect(TICKS_PER_SECOND % step).toBeCloseTo(0, 6);
      // A whole second is always labelled, so timecode never goes missing.
      if (labelTicks < TICKS_PER_SECOND) {
        expect(TICKS_PER_SECOND % labelTicks).toBeCloseTo(0, 6);
      }
    }
  });

  it("uses whole-second and coarser steps when zoomed out", () => {
    // Minimum zoom: 10px/s, so a second is too narrow to gradate.
    expect(chooseRulerScale(10, FPS)).toEqual({
      gradationTicks: 2 * TICKS_PER_SECOND,
      labelTicks: 10 * TICKS_PER_SECOND,
      frameLabels: false,
    });
    expect(chooseRulerScale(100, FPS)).toEqual({
      gradationTicks: 3 * getTicksPerFrame(FPS),
      labelTicks: TICKS_PER_SECOND,
      frameLabels: false,
    });
  });

  it("falls back to the frame step for a frame rate with no divisors", () => {
    const frame = getTicksPerFrame(23);
    expect(chooseRulerScale(2000, 23).gradationTicks).toBe(frame);
    // 23 has no divisor between 1 and itself, so the next step up is a second.
    expect(chooseRulerScale(2000, 23).labelTicks).toBe(TICKS_PER_SECOND);
  });
});

describe("formatRulerLabel", () => {
  it("renders whole seconds as MM:SS", () => {
    expect(formatRulerLabel(4 * TICKS_PER_SECOND, FPS, true)).toBe("00:04");
    expect(formatRulerLabel(75 * TICKS_PER_SECOND, FPS, false)).toBe("01:15");
    expect(formatRulerLabel(0, FPS, false)).toBe("00:00");
  });

  it("renders past an hour as H:MM:SS", () => {
    expect(formatRulerLabel(3725 * TICKS_PER_SECOND, FPS, false)).toBe(
      "1:02:05",
    );
  });

  it("renders sub-second labels as frame offsets into the second", () => {
    expect(formatRulerLabel(4 * TICKS_PER_SECOND + 2 * FRAME, FPS, true)).toBe(
      "2f",
    );
    expect(formatRulerLabel(4 * TICKS_PER_SECOND + 22 * FRAME, FPS, true)).toBe(
      "22f",
    );
  });

  it("ignores frame offsets when labels are a second or coarser", () => {
    expect(formatRulerLabel(2 * TICKS_PER_SECOND + FRAME, FPS, false)).toBe(
      "00:02",
    );
  });
});
