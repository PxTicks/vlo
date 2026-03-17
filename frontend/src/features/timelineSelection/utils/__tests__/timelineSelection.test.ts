import { describe, expect, it } from "vitest";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../timelineSelection";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("timelineSelection helpers", () => {
  it("resolves selection fps over project fps", () => {
    expect(resolveSelectionFps({ fps: 24 }, 30)).toBe(24);
    expect(resolveSelectionFps({ fps: null }, 30)).toBe(30);
  });

  it("falls back to project fps when selection fps is missing", () => {
    expect(resolveSelectionFps({}, 30)).toBe(30);
  });

  it("resolves frame step with sane defaults", () => {
    expect(resolveSelectionFrameStep({ frameStep: 8 })).toBe(8);
    expect(resolveSelectionFrameStep({ frameStep: 0 })).toBe(1);
    expect(resolveSelectionFrameStep(undefined)).toBe(1);
  });

  it("snaps frame counts to step*n + 1", () => {
    expect(snapFrameCountToStep(30, 4, "floor")).toBe(29);
    expect(snapFrameCountToStep(31, 4, "floor")).toBe(29);
    expect(snapFrameCountToStep(1, 8, "floor")).toBe(1);
  });

  it("computes ticks per frame from fps", () => {
    expect(getTicksPerFrame(30)).toBe(TICKS_PER_SECOND / 30);
  });
});
