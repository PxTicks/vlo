import { describe, expect, it } from "vitest";
import {
  createFrameFilterRenderContext,
  createStatelessFilterRenderContext,
} from "../renderSampleContext";

describe("createFrameFilterRenderContext", () => {
  it("seeds a non-zero, frozen sample from the presentation tick", () => {
    const context = createFrameFilterRenderContext(96_000, 30, "preview");
    expect(context).toMatchObject({
      sequenceId: 0,
      sampleId: 96_000,
      mode: "preview",
      continuity: "sequential",
      presentationTimeTicks: 96_000,
      visualTimeTicks: 96_000,
      sourceTimeTicks: 96_000,
      deltaTimeTicks: null,
      fps: 30,
      isWarmup: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("uses the presentation tick as a stable sample id across duplicate frames", () => {
    // Two renders of the same frame observe the same identity; a different tick
    // is a different sample. This is what makes a paused re-render a repeat.
    const a = createFrameFilterRenderContext(48_000, 24, "export");
    const b = createFrameFilterRenderContext(48_000, 24, "export");
    const c = createFrameFilterRenderContext(48_050, 24, "export");
    expect(a.sampleId).toBe(b.sampleId);
    expect(c.sampleId).not.toBe(a.sampleId);
    expect(a.mode).toBe("export");
  });

  it("rounds fractional ticks and rejects a non-positive fps", () => {
    const context = createFrameFilterRenderContext(100.6, 0, "still");
    expect(context.sampleId).toBe(101);
    expect(context.visualTimeTicks).toBe(101);
    expect(context.fps).toBe(0);
  });
});

describe("createStatelessFilterRenderContext", () => {
  it("stays a zero-time cold sample so it never animates a temporal filter", () => {
    const context = createStatelessFilterRenderContext();
    expect(context.visualTimeTicks).toBe(0);
    expect(context.continuity).toBe("initial");
  });
});
