import React from "react";
import { Box } from "@mui/material";

interface TimelineBodyProps {
  trackId: string;
  isAlternate: boolean;
  isVisible: boolean;
}

function TimelineBodyComponent({ isAlternate, isVisible }: TimelineBodyProps) {
  return (
    <Box
      sx={{
        flexGrow: 1,
        position: "relative",
        bgcolor: isAlternate ? "#1a1a1a" : "#161616",
        opacity: isVisible ? 1 : 0.3,
        transition: "opacity 0.2s ease",
        borderBottom: "1px solid #222",
      }}
      data-testid="timeline-body"
    />
  );
}

export const TimelineBody = React.memo(TimelineBodyComponent);
