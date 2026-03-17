// components/HoverGapIndicator.tsx

import { Box } from "@mui/material";
import { RULER_HEIGHT } from "../constants"; // Import

interface Props {
  gapIndex: number | null;
  trackHeight: number;
}

export const HoverGapIndicator = ({ gapIndex, trackHeight }: Props) => {
  if (gapIndex === null) return null;

  return (
    <Box
      sx={{
        position: "absolute",
        top: gapIndex * trackHeight + RULER_HEIGHT - 2,
        left: 0,
        right: 0,
        height: "2px",
        boxShadow: "0 0 8px 2px cyan",
        backgroundColor: "cyan",
        zIndex: 30,
        pointerEvents: "none",
        // Center the line exactly on the grid boundary
        transform: "translateY(+1px)",
      }}
    />
  );
};
