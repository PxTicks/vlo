import React, { useRef, useEffect, useState } from "react";
import { Box } from "@mui/material";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useProjectStore } from "../../project/useProjectStore";
import { TRACK_HEADER_WIDTH, RULER_HEIGHT } from "../constants";
import { snapTickToFrameGrid } from "../../../core/time/frameGrid";
import {
  pixelsPerSecond,
  pxToTicks as pxToTicksAt,
  ticksToPx as ticksToPxAt,
} from "../../../core/time/pixelGrid";
import { chooseRulerScale, formatRulerLabel } from "../model/rulerScale";
import { playbackClock } from "../../../core/playback/PlaybackClock";

/**
 * The two tones of the gradation hierarchy, against the #1a1a1a ruler ground.
 * The labelled gradations and their labels share one bright tone; the
 * interstitial marks sit close to the ground so they read as a fine measure
 * under the labelled ones rather than competing with them.
 */
const LABELLED_TICK_COLOR = "#c8c8c8";
const INTERSTITIAL_TICK_COLOR = "#454545";

interface TimelineRulerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function TimelineRuler({ scrollContainerRef }: TimelineRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Local state for canvas sizing (Viewport Width)
  const [width, setWidth] = useState(0);

  // fps decides the sub-second rungs of the gradation ladder, so the ruler
  // re-scales on a project fps change the same way it does on a zoom change.
  const fps = useProjectStore((state) => state.config.fps);

  // 1. Handle Resize: Observe the SCROLL CONTAINER (Viewport), not the content
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  // 2. Draw Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!canvas || !scrollContainer || width === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const { zoomScale } = useTimelineViewStore.getState();
      const pps = pixelsPerSecond(zoomScale);

      const scrollLeft = scrollContainer.scrollLeft;

      // Clear
      ctx.clearRect(0, 0, width, RULER_HEIGHT);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, width, RULER_HEIGHT);

      // Draw Bottom Border
      ctx.beginPath();
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      ctx.moveTo(0, RULER_HEIGHT - 0.5);
      ctx.lineTo(width, RULER_HEIGHT - 0.5);
      ctx.stroke();

      // Calculation for drawing
      // Time 0 starts at TRACK_HEADER_WIDTH.
      // We are drawing on a canvas that is stuck to the viewport left (0).
      // So Time 0 is at x = TRACK_HEADER_WIDTH - scrollLeft.

      const startX = TRACK_HEADER_WIDTH - scrollLeft;

      // We only draw gradations that land on the canvas (x in 0..width), which
      // in tick space is the span the canvas covers: x = ticksToPx(tick) +
      // startX, so tick = pxToTicks(x - startX), clamped at time 0.
      const { gradationTicks, labelTicks, frameLabels } = chooseRulerScale(
        pps,
        fps,
      );
      const firstVisibleTick = Math.max(0, pxToTicksAt(-startX, zoomScale));
      const lastVisibleTick = pxToTicksAt(width - startX, zoomScale);

      // Step by index rather than accumulating ticks: `gradationTicks` is
      // fractional whenever fps does not divide the tick base, and accumulated
      // error would drag the whole-second gradations off the second.
      const firstIndex = Math.floor(firstVisibleTick / gradationTicks);
      const lastIndex = Math.ceil(lastVisibleTick / gradationTicks);
      const labelEvery = Math.max(1, Math.round(labelTicks / gradationTicks));

      // Split into two passes so each tone gets its own path: the labelled
      // gradations carry the structure and are drawn at label brightness, the
      // interstitial ones recede to a dim grey.
      const labelledX: number[] = [];
      const interstitialX: number[] = [];
      const labels: { x: number; text: string }[] = [];

      for (let index = Math.max(0, firstIndex); index <= lastIndex; index++) {
        const tick = index * gradationTicks;
        const x = ticksToPxAt(tick, zoomScale) + startX;

        if (index % labelEvery === 0) {
          labelledX.push(x);
          labels.push({ x, text: formatRulerLabel(tick, fps, frameLabels) });
        } else {
          interstitialX.push(x);
        }
      }

      const strokeGradations = (xs: number[], height: number, color: string) => {
        if (xs.length === 0) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        for (const x of xs) {
          ctx.moveTo(x + 0.5, RULER_HEIGHT);
          ctx.lineTo(x + 0.5, RULER_HEIGHT - height);
        }
        ctx.stroke();
      };

      strokeGradations(interstitialX, 5, INTERSTITIAL_TICK_COLOR);
      strokeGradations(labelledX, 10, LABELLED_TICK_COLOR);

      // Labels share the exact tone of the gradation they name, so a label and
      // its mark read as one unit against the dimmer interstitial marks.
      ctx.fillStyle = LABELLED_TICK_COLOR;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      for (const { x, text } of labels) {
        ctx.fillText(text, x + 4, 14);
      }

      // Draw sticky top-left corner to hide scrolling ticks
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, TRACK_HEADER_WIDTH, RULER_HEIGHT);

      ctx.beginPath();
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      // Bottom border
      ctx.moveTo(0, RULER_HEIGHT - 0.5);
      ctx.lineTo(TRACK_HEADER_WIDTH, RULER_HEIGHT - 0.5);
      // Right border
      ctx.moveTo(TRACK_HEADER_WIDTH - 0.5, 0);
      ctx.lineTo(TRACK_HEADER_WIDTH - 0.5, RULER_HEIGHT);
      ctx.stroke();
    };

    // Initial Draw
    draw();

    // Subscribe to changes
    const handleScroll = () => requestAnimationFrame(draw);
    scrollContainer.addEventListener("scroll", handleScroll);

    const unsubscribeStore = useTimelineViewStore.subscribe(() => {
      requestAnimationFrame(draw);
    });

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      unsubscribeStore();
    };
  }, [width, scrollContainerRef, fps]);

  // --- Interaction ---
  const handleScrub = (clientX: number) => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const scrollLeft = scrollContainer.scrollLeft;

    // Inverse of drawing logic:
    // x = time * pps + TRACK_HEADER_WIDTH - scrollLeft
    // time * pps = x - TRACK_HEADER_WIDTH + scrollLeft
    const absolutePx = clickX + scrollLeft - TRACK_HEADER_WIDTH;

    const { pxToTicks } = useTimelineViewStore.getState();
    const rawTicks = pxToTicks(absolutePx);

    // Snap to Frame
    const fps = useProjectStore.getState().config.fps;
    const snappedTicks = snapTickToFrameGrid(rawTicks, fps);

    playbackClock.setTime(snappedTicks);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    handleScrub(e.clientX);

    const handleMouseMove = (ev: MouseEvent) => {
      handleScrub(ev.clientX);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <Box
      ref={containerRef}
      onClick={(e) => e.stopPropagation()}
      sx={{
        display: "flex",
        position: "sticky",
        top: 0,
        zIndex: 40,
        width: "100%", // Expands to fill TimelineContainer
        height: `${RULER_HEIGHT}px`,
        pointerEvents: "none", // Let clicks pass through if not on canvas? No, canvas needs pointer.
      }}
      data-testid="timeline-ruler"
    >
      <canvas
        ref={canvasRef}
        width={width} // Viewport width
        height={RULER_HEIGHT}
        style={{
          display: "block",
          cursor: "pointer",
          position: "sticky",
          left: 0,
          pointerEvents: "auto",
          backgroundColor: "#1a1a1a",
        }}
        onMouseDown={handleMouseDown}
      />
    </Box>
  );
}
