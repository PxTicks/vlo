import { Box, Slider, Stack, IconButton, Tooltip } from "@mui/material";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import ZoomOutIcon from "@mui/icons-material/ZoomOut";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import VerticalAlignCenterIcon from "@mui/icons-material/VerticalAlignCenter";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { useTimelineStore } from "../useTimelineStore";
import { playbackClock } from "../../player/services/PlaybackClock";
import { MIN_ZOOM, MAX_ZOOM } from "../constants";

export const TimelineToolbar = () => {
  const zoomScale = useTimelineViewStore((state) => state.zoomScale);
  const setZoomScale = useTimelineViewStore((state) => state.setZoomScale);
  const snappingEnabled = useInteractionStore((state) => state.snappingEnabled);
  const toggleSnappingEnabled = useInteractionStore(
    (state) => state.toggleSnappingEnabled,
  );

  const handleSliderChange = (_: Event, newValue: number | number[]) => {
    setZoomScale(newValue as number);
  };

  return (
    <Box
      sx={{
        p: 1,
        borderBottom: "1px solid #333",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between", // Spread out
        height: "40px",
        bgcolor: "#1a1a1a",
      }}
      data-testid="timeline-toolbar"
    >
      {/* Left Tools */}
      <Stack direction="row" spacing={1} sx={{ ml: 2 }}>
        <Tooltip
          title={snappingEnabled ? "Timeline Snapping: On" : "Timeline Snapping: Off"}
        >
          <IconButton
            size="small"
            data-testid="timeline-snapping-toggle"
            onClick={toggleSnappingEnabled}
            aria-label={snappingEnabled ? "Disable timeline snapping" : "Enable timeline snapping"}
            aria-pressed={snappingEnabled}
            sx={{ color: snappingEnabled ? "#fbc02d" : "#666" }}
          >
            <VerticalAlignCenterIcon
              fontSize="small"
              sx={{ transform: "rotate(90deg)" }}
            />
          </IconButton>
        </Tooltip>

        <Tooltip title="Split Clip (Cut)">
          <IconButton
            size="small"
            onClick={() => {
              const currentTime = playbackClock.time;
              const state = useTimelineStore.getState();

              let idsToSplit = [...state.selectedClipIds];

              // If no clips are selected, split ALL clips under the playhead (Razor behavior)
              if (idsToSplit.length === 0) {
                const intersectingClips = state.clips.filter(
                  (c) =>
                    c.type !== "mask" &&
                    c.start < currentTime &&
                    c.start + c.timelineDuration > currentTime,
                );
                idsToSplit = intersectingClips.map((c) => c.id);
              } else {
                // If there IS a selection, we should only split selected clips that ACTUALLY intersect
                // To prevent errors or weird behavior if we try to split a clip not under playhead
                const clips = state.clips;
                idsToSplit = idsToSplit.filter((id) => {
                  const c = clips.find((clip) => clip.id === id);
                  return (
                    c &&
                    c.type !== "mask" &&
                    c.start < currentTime &&
                    c.start + c.timelineDuration > currentTime
                  );
                });
              }

              idsToSplit.forEach((id) => {
                state.splitClip(id, currentTime);
              });
            }}
            sx={{ color: "#eee" }}
          >
            <ContentCutIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Right Zoom Controls */}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ width: 200, mr: 2 }}
      >
        <ZoomOutIcon sx={{ color: "#888", fontSize: 20 }} />
        <Slider
          size="small"
          value={zoomScale}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.1}
          onChange={handleSliderChange}
          sx={{
            color: "#555",
            "& .MuiSlider-thumb": {
              width: 12,
              height: 12,
              transition: "0.2s",
              "&:hover, &.Mui-focusVisible": {
                boxShadow: "0px 0px 0px 8px rgba(255, 255, 255, 0.16)",
              },
            },
          }}
        />
        <ZoomInIcon sx={{ color: "#888", fontSize: 20 }} />
      </Stack>
    </Box>
  );
};
