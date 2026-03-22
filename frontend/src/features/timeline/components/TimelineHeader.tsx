import React from "react";
import { Box, IconButton } from "@mui/material";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { TRACK_HEADER_WIDTH } from "../constants";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import type { TrackType } from "../../../types/TimelineTypes";

interface TimelineHeaderProps {
  isVisible: boolean;
  isMuted?: boolean; // New prop
  derivedType: TrackType | null;
  color: string;
  onToggleVisibility: () => void;
  onToggleMute: () => void; // New prop
}

export const TimelineHeader = React.memo(function TimelineHeader({
  isVisible,
  isMuted = false,
  derivedType,
  color,
  onToggleVisibility,
  onToggleMute,
}: TimelineHeaderProps) {
  const handleToggleMuteClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onToggleMute();
    },
    [onToggleMute],
  );

  const handleToggleVisibilityClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onToggleVisibility();
    },
    [onToggleVisibility],
  );

  // Logic: What controls do we show?
  const showVisibility = derivedType !== "audio"; // Audio doesn't need "visible"
  const showMute = derivedType === "visual" || derivedType === "audio";

  return (
    <Box
      data-testid="timeline-track-header"
      sx={{
        width: TRACK_HEADER_WIDTH,
        borderRight: "1px solid #333",
        borderBottom: "1px solid #222",
        p: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        bgcolor: "#222",
        position: "sticky",
        left: 0,
        zIndex: 60,
        borderLeft: `4px solid ${color}`,
      }}
    >
      <Box sx={{ flexGrow: 1 }} />

      <Box sx={{ display: "flex", gap: 0.5 }}>
        {showMute && (
          <IconButton
            size="small"
            onClick={handleToggleMuteClick}
            data-testid="track-mute-toggle"
            aria-label={isMuted ? "Unmute track" : "Mute track"}
            aria-pressed={isMuted}
          >
            {isMuted ? (
              <VolumeOffIcon fontSize="small" color="error" />
            ) : (
              <VolumeUpIcon fontSize="small" />
            )}
          </IconButton>
        )}

        {showVisibility && (
          <IconButton
            size="small"
            onClick={handleToggleVisibilityClick}
            data-testid="track-visibility-toggle"
            aria-label={isVisible ? "Hide track" : "Show track"}
            aria-pressed={isVisible}
          >
            {isVisible ? (
              <VisibilityIcon fontSize="small" />
            ) : (
              <VisibilityOffIcon fontSize="small" />
            )}
          </IconButton>
        )}
      </Box>
    </Box>
  );
});
