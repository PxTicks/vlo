import { describe, it, expect } from "vitest";
import {
  tickToMediaSeconds,
  mediaSecondsToTick,
  mediaTimestampToFirstAvailableTick,
  frameIndexToOutputTimestamp,
  snapFrameTimeSeconds,
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
});
