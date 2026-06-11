import { describe, it, expect } from "vitest";
import {
  ticksPerFrame,
  frameToTick,
  tickToFrame,
  snapTickToFrameGrid,
  snapTickToGrid,
  frameIndexFromTick,
  FRAME_INDEX_EPSILON,
} from "../../../../core/time/frameGrid";
import { TICKS_PER_SECOND } from "../../constants";

const PROJECT_FPS = [16, 24, 25, 30, 60];

describe("frameGrid", () => {
  describe("ticksPerFrame", () => {
    it("is an exact integer for every supported project fps", () => {
      for (const fps of PROJECT_FPS) {
        const tpf = ticksPerFrame(fps);
        expect(Number.isInteger(tpf)).toBe(true);
        expect(tpf).toBe(TICKS_PER_SECOND / fps);
      }
    });

    it("guards non-finite / non-positive fps", () => {
      expect(ticksPerFrame(0)).toBe(TICKS_PER_SECOND);
      expect(ticksPerFrame(-5)).toBe(TICKS_PER_SECOND);
      expect(ticksPerFrame(Number.NaN)).toBe(TICKS_PER_SECOND);
    });
  });

  describe("frameToTick / tickToFrame round-trip", () => {
    it("round-trips frame -> tick -> frame exactly for project fps", () => {
      for (const fps of PROJECT_FPS) {
        for (const frame of [0, 1, 2, 7, 100, 12345]) {
          const tick = frameToTick(frame, fps);
          expect(Number.isInteger(tick)).toBe(true);
          expect(tickToFrame(tick, fps, "nearest")).toBe(frame);
        }
      }
    });
  });

  describe("epsilon-tolerant ceiling (the FP linchpin)", () => {
    const fps = 30;
    const tpf = ticksPerFrame(fps); // 3200

    it("maps an exactly-aligned tick to its own frame, never the next", () => {
      expect(tickToFrame(3 * tpf, fps, "ceil")).toBe(3);
    });

    it("treats a sub-epsilon under/overshoot as on-grid (3 not 4)", () => {
      const justUnder = 3 * tpf - tpf * (FRAME_INDEX_EPSILON / 2);
      const justOver = 3 * tpf + tpf * (FRAME_INDEX_EPSILON / 2);
      expect(tickToFrame(justUnder, fps, "ceil")).toBe(3);
      expect(tickToFrame(justOver, fps, "ceil")).toBe(3);
      // floor/nearest agree on an on-grid value too
      expect(tickToFrame(justOver, fps, "floor")).toBe(3);
      expect(tickToFrame(justUnder, fps, "nearest")).toBe(3);
    });

    it("still rounds genuinely off-grid positions per mode", () => {
      const midFrame = 3.5 * tpf;
      expect(tickToFrame(midFrame, fps, "ceil")).toBe(4);
      expect(tickToFrame(midFrame, fps, "floor")).toBe(3);
      // a clearly-fractional value below .5 ceils up but floors/rounds down
      const lowFraction = 3.2 * tpf;
      expect(tickToFrame(lowFraction, fps, "ceil")).toBe(4);
      expect(tickToFrame(lowFraction, fps, "floor")).toBe(3);
      expect(tickToFrame(lowFraction, fps, "nearest")).toBe(3);
    });
  });

  describe("snapTickToFrameGrid", () => {
    it("returns a grid-aligned tick (frame * tpf)", () => {
      const fps = 24;
      const tpf = ticksPerFrame(fps); // 4000
      expect(snapTickToFrameGrid(2.7 * tpf, fps, "ceil")).toBe(3 * tpf);
      expect(snapTickToFrameGrid(2.7 * tpf, fps, "floor")).toBe(2 * tpf);
      expect(snapTickToFrameGrid(3 * tpf, fps, "ceil")).toBe(3 * tpf);
    });
  });

  describe("snapTickToGrid (tpf core, delegation path)", () => {
    it("nearest mode matches legacy round(tick/tpf)*tpf", () => {
      const tpf = 3200;
      for (const tick of [0, 1599, 1600, 1601, 4800, 9999]) {
        expect(snapTickToGrid(tick, tpf, "nearest")).toBe(
          Math.round(tick / tpf) * tpf,
        );
      }
    });

    it("frameIndexFromTick honors the tpf core directly", () => {
      expect(frameIndexFromTick(6400, 3200, "nearest")).toBe(2);
      expect(frameIndexFromTick(6401, 3200, "floor")).toBe(2);
      expect(frameIndexFromTick(6401, 3200, "ceil")).toBe(3);
    });
  });
});
