import React, { useRef, useEffect, useState } from "react";
import { Box } from "@mui/material";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useProjectStore } from "../../project/useProjectStore";
import {
  PIXELS_PER_SECOND,
  TRACK_HEADER_WIDTH,
  RULER_HEIGHT,
  TICKS_PER_SECOND,
} from "../constants";
import { playbackClock } from "../../player/services/PlaybackClock";

interface TimelineRulerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function TimelineRuler({ scrollContainerRef }: TimelineRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Local state for canvas sizing (Viewport Width)
  const [width, setWidth] = useState(0);

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
      const pps = PIXELS_PER_SECOND * zoomScale;

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

      // We only want to draw ticks that are visible on the canvas (0 to width)
      // x = sec * pps + startX
      // 0 <= sec * pps + startX <= width
      // -startX <= sec * pps <= width - startX
      // -startX / pps <= sec <= (width - startX) / pps

      const startSec = Math.floor(Math.max(0, -startX / pps));
      const endSec = Math.ceil((width - startX) / pps);

      ctx.beginPath();
      ctx.strokeStyle = "#555";
      ctx.fillStyle = "#888";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";

      for (let sec = startSec; sec <= endSec; sec++) {
        const x = sec * pps + startX;

        // Major Tick (every 5s) or dynamic based on zoom?
        const isMajor = sec % 5 === 0;
        const tickHeight = isMajor ? 10 : 5;

        // Draw tick
        ctx.moveTo(x + 0.5, RULER_HEIGHT);
        ctx.lineTo(x + 0.5, RULER_HEIGHT - tickHeight);

        // Draw Label
        if (isMajor) {
          ctx.fillText(`${sec}s`, x + 4, 14);
        }
      }
      ctx.stroke();

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
  }, [width, scrollContainerRef]);

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
    const ticksPerFrame = TICKS_PER_SECOND / fps; // TICKS_PER_SECOND / fps
    const snappedTicks = Math.round(rawTicks / ticksPerFrame) * ticksPerFrame;

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
