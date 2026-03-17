import { memo } from "react";
import {
  IconButton,
  Stack,
  Paper,
  Tooltip,
  Divider,
  Button,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import FitScreenIcon from "@mui/icons-material/FitScreen";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";

interface PlayerControlsProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onFitView?: () => void;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  onOpenExport: () => void;
  exportDisabled?: boolean;
}

export const PlayerControls = memo(function PlayerControls({
  isPlaying,
  onTogglePlay,
  onFitView,
  onToggleFullscreen,
  isFullscreen = false,
  onOpenExport,
  exportDisabled = false,
}: PlayerControlsProps) {
  return (
    <Paper
      data-testid="player-controls"
      square
      elevation={0}
      sx={{
        p: 0.5,
        bgcolor: "#111",
        borderTop: "1px solid #333",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 10,
      }}
    >
      <Stack direction="row" spacing={2} alignItems="center">
        <Tooltip title={isPlaying ? "Pause" : "Play"}>
          <IconButton
            onClick={onTogglePlay}
            sx={{
              color: "#fff",
              bgcolor: isPlaying ? "rgba(255, 255, 255, 0.1)" : "primary.main",
              "&:hover": {
                bgcolor: isPlaying
                  ? "rgba(255, 255, 255, 0.2)"
                  : "primary.dark",
              },
              width: 32,
              height: 32,
            }}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <PauseIcon fontSize="small" />
            ) : (
              <PlayArrowIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>

        {onFitView && (
          <>
            <Divider orientation="vertical" flexItem sx={{ bgcolor: "#333" }} />
            <Tooltip title="Fit to Screen">
              <IconButton
                onClick={onFitView}
                sx={{ color: "#aaa", "&:hover": { color: "#fff" } }}
                aria-label="Fit to Screen"
              >
                <FitScreenIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {onToggleFullscreen && (
              <Tooltip
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              >
                <IconButton
                  onClick={onToggleFullscreen}
                  sx={{ color: "#aaa", "&:hover": { color: "#fff" } }}
                  aria-label={
                    isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"
                  }
                >
                  {isFullscreen ? (
                    <FullscreenExitIcon fontSize="small" />
                  ) : (
                    <FullscreenIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
            )}
          </>
        )}

        {!isFullscreen && (
          <>
            <Divider orientation="vertical" flexItem sx={{ bgcolor: "#333" }} />

            <Button
              variant="contained"
              size="small"
              onClick={onOpenExport}
              disabled={exportDisabled}
              sx={{
                bgcolor: "#333",
                color: "#fff",
                py: 0.5,
                px: 2,
                minWidth: 0,
                fontSize: "0.75rem",
                "&:hover": { bgcolor: "#444" },
                "&.Mui-disabled": {
                  bgcolor: "#2a2a2a",
                  color: "#666",
                },
              }}
            >
              Extract
            </Button>
          </>
        )}
      </Stack>
    </Paper>
  );
});
