import { describe, it, expect } from "vitest";
import {
  tickToMediaSeconds,
  mediaSecondsToTick,
  mediaSecondsToTickExact,
  mediaTimestampToFirstAvailableTick,
  frameIndexToOutputTimestamp,
  snapFrameTimeSeconds,
  getRenderedSourceFrameReferenceFromTicks,
  getRenderedSourceFrameReferenceFromSeconds,
} from "../mediaTime";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("mediaTime boundary", () => {
  describe("tick <-> seconds", () => {
    it("tickToMediaSeconds is the exact rational tick/96000", () => {
      expect(tickToMediaSeconds(TICKS_PER_SECOND)).toBe(1);
      expect(tickToMediaSeconds(TICKS_PER_SECOND / 2)).toBe(0.5);
      expect(tickToMediaSeconds(0)).toBe(0);
    });

    it("round-trips integer ticks: mediaSecondsToTick(tickToMediaSeconds(t)) === t", () => {
      for (const t of [0, 1, 1600, 3200, 4000, 96000, 1234567]) {
        expect(mediaSecondsToTick(tickToMediaSeconds(t))).toBe(t);
      }
    });

    it("mediaSecondsToTick honors rounding mode", () => {
      const halfTick = (0.5 / TICKS_PER_SECOND) * TICKS_PER_SECOND; // 0.5 ticks
      const seconds = 1.5 / TICKS_PER_SECOND; // 1.5 ticks
      expect(mediaSecondsToTick(seconds, "floor")).toBe(1);
      expect(mediaSecondsToTick(seconds, "ceil")).toBe(2);
      expect(mediaSecondsToTick(seconds, "nearest")).toBe(2);
      expect(halfTick).toBe(0.5);
    });

    it("mediaTimestampToFirstAvailableTick ceils to the next tick", () => {
      const seconds = 2.1 / TICKS_PER_SECOND; // 2.1 ticks
      expect(mediaTimestampToFirstAvailableTick(seconds)).toBe(3);
      // already-on-tick stays put
      expect(mediaTimestampToFirstAvailableTick(tickToMediaSeconds(5))).toBe(5);
    });

    it("ceil/floor of tick-derived seconds round-trip exactly (no FP-dust drift)", () => {
      // tickToMediaSeconds(7) * TICKS_PER_SECOND === 7.000000000000001; a raw
      // Math.ceil would return 8. These ticks all exhibit the dust.
      for (const t of [7, 14, 28, 51, 95, 102, 1234567]) {
        const s = tickToMediaSeconds(t);
        expect(mediaSecondsToTick(s, "ceil")).toBe(t);
        expect(mediaSecondsToTick(s, "floor")).toBe(t);
        expect(mediaTimestampToFirstAvailableTick(s)).toBe(t);
      }
    });

    it("still rounds genuinely fractional seconds (epsilon isn't over-eager)", () => {
      const s = 2.1 / TICKS_PER_SECOND; // 2.1 ticks — well past the epsilon
      expect(mediaSecondsToTick(s, "floor")).toBe(2);
      expect(mediaSecondsToTick(s, "ceil")).toBe(3);
    });

    it("mediaSecondsToTickExact keeps fractional ticks (no rounding)", () => {
      // Continuous-clock conversion must NOT quantize.
      expect(mediaSecondsToTickExact(1.5 / TICKS_PER_SECOND)).toBeCloseTo(
        1.5,
        9,
      );
      expect(mediaSecondsToTickExact(2.7 / TICKS_PER_SECOND)).toBeCloseTo(
        2.7,
        9,
      );
      // exact inverse of tickToMediaSeconds for fractional ticks
      for (const t of [0.25, 1.5, 3200.7, 99999.1]) {
        expect(mediaSecondsToTickExact(tickToMediaSeconds(t))).toBeCloseTo(
          t,
          6,
        );
      }
    });
  });

  describe("frameIndexToOutputTimestamp", () => {
    it("is frame-index based and strictly monotonic (i/fps)", () => {
      const fps = 30;
      let prev = -1;
      for (let i = 0; i < 10; i += 1) {
        const ts = frameIndexToOutputTimestamp(i, fps);
        expect(ts).toBe(i / fps);
        expect(ts).toBeGreaterThan(prev);
        prev = ts;
      }
    });

    it("guards non-finite / non-positive fps", () => {
      expect(frameIndexToOutputTimestamp(3, 0)).toBe(3);
      expect(frameIndexToOutputTimestamp(3, Number.NaN)).toBe(3);
    });
  });

  describe("snapFrameTimeSeconds", () => {
    it("snaps to the nearest 1/fps grid and clamps negatives", () => {
      expect(snapFrameTimeSeconds(0.04, 30)).toBe(Math.round(0.04 * 30) / 30);
      expect(snapFrameTimeSeconds(-1, 30)).toBe(0);
    });
  });

  describe("getRenderedSourceFrameReference", () => {
    it("returns the canonical source frame the renderer will sample", () => {
      const frame = getRenderedSourceFrameReferenceFromTicks(2000, 30);

      expect(frame.frameIndex).toBe(1);
      expect(frame.timeSeconds).toBe(1 / 30);
      expect(frame.timeTicks).toBe(TICKS_PER_SECOND / 30);
    });

    it("clamps to the available source frame count", () => {
      const frame = getRenderedSourceFrameReferenceFromSeconds(10, 30, 10);

      expect(frame.frameIndex).toBe(9);
      expect(frame.timeSeconds).toBe(9 / 30);
      expect(frame.timeTicks).toBe((9 * TICKS_PER_SECOND) / 30);
    });

    it("uses the same source frame for all times that snap to it", () => {
      const first = getRenderedSourceFrameReferenceFromSeconds(1 / 24, 12);
      const second = getRenderedSourceFrameReferenceFromSeconds(1.9 / 24, 12);

      expect(first.frameIndex).toBe(1);
      expect(second.frameIndex).toBe(1);
      expect(first.timeTicks).toBe(second.timeTicks);
    });
  });
});
