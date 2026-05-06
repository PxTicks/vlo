import React from "react";
import { Box, Checkbox, IconButton, Typography } from "@mui/material";
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
  selectionIncludeModeEnabled?: boolean;
  isIncludedInSelection?: boolean;
  onToggleVisibility: () => void;
  onToggleMute: () => void; // New prop
  onToggleSelectionInclude?: () => void;
}

export const TimelineHeader = React.memo(function TimelineHeader({
  isVisible,
  isMuted = false,
  derivedType,
  color,
  selectionIncludeModeEnabled = false,
  isIncludedInSelection = false,
  onToggleVisibility,
  onToggleMute,
  onToggleSelectionInclude,
}: TimelineHeaderProps) {
  const handleToggleSelectionIncludeClick = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      event.stopPropagation();
      onToggleSelectionInclude?.();
    },
    [onToggleSelectionInclude],
  );

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
      {selectionIncludeModeEnabled ? (
        <Box
          sx={{
            position: "absolute",
            top: 6,
            left: 8,
            display: "flex",
            alignItems: "center",
            gap: 0.25,
            pr: 0.5,
            borderRadius: 999,
            bgcolor: "rgba(12, 20, 26, 0.92)",
            border: "1px solid rgba(79, 195, 247, 0.35)",
            boxShadow: "0 4px 10px rgba(0, 0, 0, 0.18)",
            zIndex: 1,
          }}
        >
          <Checkbox
            size="small"
            checked={isIncludedInSelection}
            onClick={(event) => event.stopPropagation()}
            onChange={handleToggleSelectionIncludeClick}
            inputProps={{
              "aria-label": isIncludedInSelection
                ? "Remove track from selection include list"
                : "Include track in selection",
            }}
            sx={{
              color: "#8aa8b6",
              p: 0.25,
              "&.Mui-checked": {
                color: "#4fc3f7",
              },
            }}
          />
          <Typography
            variant="caption"
            sx={{ color: "#d7ecf6", letterSpacing: 0.2, userSelect: "none" }}
          >
            Include
          </Typography>
        </Box>
      ) : null}

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
