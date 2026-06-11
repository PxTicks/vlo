import { useEffect, useRef } from "react";
import { Box } from "@mui/material";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { TRACK_HEADER_WIDTH } from "../constants";
import { ticksToPx } from "../../../core/time/pixelGrid";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { useTimelineSelectionStore } from "../../timelineSelection";

export const TimelinePlayhead = () => {
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      if (!lineRef.current) return;

      const currentTime = playbackClock.time;
      const { zoomScale } = useTimelineViewStore.getState();

      // Match the exact formula structure of TimelineClip.tsx:
      // 1. Calculate base pixels (unzoomed)
      const basePx = ticksToPx(currentTime, 1);
      // 2. Apply zoom
      const x = basePx * zoomScale;

      // Use translate3d for hardware acceleration
      lineRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    };

    // Initial update
    updatePosition();

    const unsubscribeClock = playbackClock.subscribe(updatePosition);
    const unsubscribeStore = useTimelineViewStore.subscribe(updatePosition);

    return () => {
      unsubscribeClock();
      unsubscribeStore();
    };
  }, []); // Run once on mount

  const selectionMode = useTimelineSelectionStore((s) => s.selectionMode);

  return (
    <Box
      ref={lineRef}
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${TRACK_HEADER_WIDTH}px`, // Fixed start position
        width: "2px",
        bgcolor: "red",
        zIndex: 42,
        pointerEvents: "none",
        willChange: "transform", // Hint to browser to optimize
        opacity: selectionMode ? 0 : 1,

        "&::before": {
          content: '""',
          position: "absolute",
          top: "0px",
          left: "-5px",
          borderLeft: "6px solid transparent",
          borderRight: "6px solid transparent",
          borderTop: "8px solid red",
        },
      }}
    />
  );
};
