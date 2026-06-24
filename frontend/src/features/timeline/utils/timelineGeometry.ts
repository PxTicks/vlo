// utils/timelineGeometry.ts
import type { CSSProperties } from "react";
import { ticksToPx } from "../../../core/time/pixelGrid";
import { TRACK_HEADER_WIDTH } from "../constants";

const zoomTerm = (basePx: number): string =>
  `${basePx}px * var(--timeline-zoom, 1)`;

export interface TimelineSpanStyleOptions {
  /**
   * Offset by the track-header gutter — for elements positioned in the
   * scrollable track area whose horizontal origin is the timeline's left edge
   * (e.g. clips, transition overlays). Omit for elements already rendered
   * inside a clip-local coordinate space.
   */
  headerOffset?: boolean;
  /** Floor for the rendered width in px (e.g. keep a tiny span clickable). */
  minWidthPx?: number;
  /**
   * Extra CSS length expression folded into the `left` calc, e.g. a live drag
   * delta (`"var(--drag-delta-x, 0px)"`). The string is concatenated verbatim,
   * so it may carry its own sign (`"+ ..."` is added automatically; embed `-`
   * inside the expression for subtraction).
   */
  extraLeft?: string;
  /** Extra CSS length expression folded into the `width` calc. */
  extraWidth?: string;
}

/**
 * Horizontal placement for an element spanning
 * `[startTicks, startTicks + durationTicks)` in the timeline track area.
 *
 * Pixels are computed at zoom = 1 and scaled with the `--timeline-zoom` CSS
 * variable, so the element re-positions on zoom **purely in CSS** — no React
 * re-render required. This is the only correct way to place a statically
 * rendered (e.g. `memo`'d) overlay: computing pixels at the live zoom inside an
 * inline style silently goes stale when the component doesn't re-render on zoom
 * (the bug this helper exists to prevent).
 *
 * The element MUST be rendered inside the container that declares
 * `--timeline-zoom` (the timeline track `Box` in `TimelineContainer`).
 */
export function timelineSpanStyleX(
  startTicks: number,
  durationTicks: number,
  opts: TimelineSpanStyleOptions = {},
): Pick<CSSProperties, "left" | "width"> {
  const left = ticksToPx(startTicks, 1);
  const width = ticksToPx(durationTicks, 1);

  const leftTerms = [
    ...(opts.headerOffset ? [`${TRACK_HEADER_WIDTH}px`] : []),
    `(${zoomTerm(left)})`,
    ...(opts.extraLeft ? [opts.extraLeft] : []),
  ];

  const widthCore = `(${zoomTerm(width)})${
    opts.extraWidth ? ` + ${opts.extraWidth}` : ""
  }`;

  return {
    left: `calc(${leftTerms.join(" + ")})`,
    width:
      opts.minWidthPx != null
        ? `max(${opts.minWidthPx}px, ${widthCore})`
        : `calc(${widthCore})`,
  };
}
