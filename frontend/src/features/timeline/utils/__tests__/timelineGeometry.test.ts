import { describe, it, expect } from "vitest";
import { timelineSpanStyleX } from "../timelineGeometry";
import { ticksToPx } from "../../../../core/time/pixelGrid";
import { TRACK_HEADER_WIDTH } from "../../constants";

describe("timelineSpanStyleX", () => {
  const start = 480;
  const duration = 240;
  const baseLeft = ticksToPx(start, 1);
  const baseWidth = ticksToPx(duration, 1);

  it("scales via the --timeline-zoom CSS variable (zoom = 1 base px)", () => {
    const { left, width } = timelineSpanStyleX(start, duration);
    expect(left).toBe(`calc((${baseLeft}px * var(--timeline-zoom, 1)))`);
    expect(width).toBe(`calc((${baseWidth}px * var(--timeline-zoom, 1)))`);
  });

  it("prepends the track-header gutter when headerOffset is set", () => {
    const { left } = timelineSpanStyleX(start, duration, {
      headerOffset: true,
    });
    expect(left).toBe(
      `calc(${TRACK_HEADER_WIDTH}px + (${baseLeft}px * var(--timeline-zoom, 1)))`,
    );
  });

  it("floors width with max() when minWidthPx is set", () => {
    const { width } = timelineSpanStyleX(start, duration, { minWidthPx: 20 });
    expect(width).toBe(
      `max(20px, (${baseWidth}px * var(--timeline-zoom, 1)))`,
    );
  });

  it("folds extra left/width expressions into the same calc", () => {
    const { left, width } = timelineSpanStyleX(start, duration, {
      headerOffset: true,
      extraLeft: "var(--drag-delta-x, 0px)",
      extraWidth: "var(--drag-delta-w, 0px)",
    });
    expect(left).toBe(
      `calc(${TRACK_HEADER_WIDTH}px + (${baseLeft}px * var(--timeline-zoom, 1)) + var(--drag-delta-x, 0px))`,
    );
    expect(width).toBe(
      `calc((${baseWidth}px * var(--timeline-zoom, 1)) + var(--drag-delta-w, 0px))`,
    );
  });
});
