import { useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Stack,
  Typography,
  IconButton,
  CircularProgress,
  Tooltip,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { TICKS_PER_SECOND } from "../timeline";
import { useMiniEditorStore } from "./useMiniEditorStore";
import { EditorTrack } from "./components/EditorTrack";

function formatTicks(ticks: number): string {
  const totalSeconds = Math.max(0, ticks) / TICKS_PER_SECOND;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centis = Math.floor((totalSeconds % 1) * 100);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${centis
    .toString()
    .padStart(2, "0")}`;
}

export function MiniEditorModal() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const isOpen = useMiniEditorStore((s) => s.isOpen);
  const title = useMiniEditorStore((s) => s.title);
  const status = useMiniEditorStore((s) => s.status);
  const error = useMiniEditorStore((s) => s.error);
  const source = useMiniEditorStore((s) => s.source);
  const durationTicks = useMiniEditorStore((s) => s.durationTicks);
  const cropStartTicks = useMiniEditorStore((s) => s.cropStartTicks);
  const cropEndTicks = useMiniEditorStore((s) => s.cropEndTicks);
  const ranges = useMiniEditorStore((s) => s.ranges);
  const selectedRangeId = useMiniEditorStore((s) => s.selectedRangeId);
  const playheadTicks = useMiniEditorStore((s) => s.playheadTicks);
  const isPlaying = useMiniEditorStore((s) => s.isPlaying);

  const close = useMiniEditorStore((s) => s.close);
  const setSourceDimensions = useMiniEditorStore((s) => s.setSourceDimensions);
  const setCrop = useMiniEditorStore((s) => s.setCrop);
  const addRangeAtPlayhead = useMiniEditorStore((s) => s.addRangeAtPlayhead);
  const updateRange = useMiniEditorStore((s) => s.updateRange);
  const removeRange = useMiniEditorStore((s) => s.removeRange);
  const toggleRange = useMiniEditorStore((s) => s.toggleRange);
  const selectRange = useMiniEditorStore((s) => s.selectRange);
  const setPlayhead = useMiniEditorStore((s) => s.setPlayhead);
  const setPlaying = useMiniEditorStore((s) => s.setPlaying);
  const save = useMiniEditorStore((s) => s.save);

  const isSaving = status === "saving";

  // Pause playback whenever we leave the "ready" state.
  useEffect(() => {
    if (status !== "ready" && isPlaying) {
      setPlaying(false);
    }
  }, [status, isPlaying, setPlaying]);

  // Drive the <video> position from the playhead while paused / scrubbing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;
    const target = playheadTicks / TICKS_PER_SECOND;
    if (Math.abs(video.currentTime - target) > 0.02) {
      video.currentTime = target;
    }
  }, [playheadTicks, isPlaying]);

  // Playback loop: follow the video clock and loop within the crop window.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!isPlaying) {
      video.pause();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const cropStartSec = cropStartTicks / TICKS_PER_SECOND;
    const cropEndSec = cropEndTicks / TICKS_PER_SECOND;
    if (video.currentTime < cropStartSec || video.currentTime >= cropEndSec) {
      video.currentTime = cropStartSec;
    }
    void video.play().catch(() => undefined);

    const tick = () => {
      const current = videoRef.current;
      if (!current) return;
      if (current.currentTime >= cropEndSec) {
        current.currentTime = cropStartSec;
      }
      setPlayhead(Math.round(current.currentTime * TICKS_PER_SECOND));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, cropStartTicks, cropEndTicks, setPlayhead]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    close();
  }, [close, isSaving]);

  const cropLabel = `${formatTicks(cropEndTicks - cropStartTicks)} (${formatTicks(
    cropStartTicks,
  )} – ${formatTicks(cropEndTicks)})`;

  return (
    <Dialog
      open={isOpen}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { bgcolor: "#161618", color: "#eee" } }}
    >
      <DialogTitle sx={{ pb: 1 }}>{title}</DialogTitle>
      <DialogContent>
        {status === "preparing" ? (
          <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary">
              Preparing video…
            </Typography>
          </Stack>
        ) : status === "error" && !source ? (
          <Stack alignItems="center" spacing={1} sx={{ py: 6 }}>
            <Typography variant="body2" color="error">
              {error ?? "Failed to load the video."}
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Box
              sx={{
                position: "relative",
                bgcolor: "#000",
                borderRadius: 1,
                overflow: "hidden",
                display: "flex",
                justifyContent: "center",
                maxHeight: 360,
              }}
            >
              <video
                ref={videoRef}
                src={source?.videoUrl}
                playsInline
                style={{ maxHeight: 360, maxWidth: "100%" }}
                onLoadedMetadata={(event) => {
                  const el = event.currentTarget;
                  setSourceDimensions(el.videoWidth, el.videoHeight);
                }}
              />
            </Box>

            <Stack direction="row" alignItems="center" spacing={1.5}>
              <IconButton
                size="small"
                onClick={() => setPlaying(!isPlaying)}
                sx={{ color: "#fff" }}
              >
                {isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
              </IconButton>
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
              >
                {formatTicks(playheadTicks)} / {formatTicks(durationTicks)}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addRangeAtPlayhead}
                sx={{ color: "#f4a0a0" }}
              >
                Add range mask
              </Button>
            </Stack>

            <EditorTrack
              durationTicks={durationTicks}
              cropStartTicks={cropStartTicks}
              cropEndTicks={cropEndTicks}
              ranges={ranges}
              selectedRangeId={selectedRangeId}
              playheadTicks={playheadTicks}
              onSetCrop={setCrop}
              onUpdateRange={updateRange}
              onSelectRange={selectRange}
              onSeek={setPlayhead}
            />

            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Crop: {cropLabel}
            </Typography>

            {ranges.length > 0 && (
              <Stack spacing={0.5}>
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", fontWeight: 600 }}
                >
                  Range masks
                </Typography>
                {ranges.map((range, index) => (
                  <Stack
                    key={range.id}
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    onClick={() => selectRange(range.id)}
                    sx={{
                      px: 1,
                      py: 0.5,
                      borderRadius: 1,
                      cursor: "pointer",
                      bgcolor:
                        range.id === selectedRangeId
                          ? "rgba(244,67,54,0.12)"
                          : "transparent",
                    }}
                  >
                    <Typography variant="caption" sx={{ minWidth: 56 }}>
                      Mask {index + 1}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        flex: 1,
                        fontVariantNumeric: "tabular-nums",
                        opacity: range.isActive ? 1 : 0.5,
                      }}
                    >
                      {formatTicks(range.startSourceTicks)} –{" "}
                      {formatTicks(range.endSourceTicks)}
                    </Typography>
                    <Tooltip title={range.isActive ? "Disable" : "Enable"}>
                      <IconButton
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleRange(range.id);
                        }}
                        sx={{ color: "text.secondary" }}
                      >
                        {range.isActive ? (
                          <VisibilityIcon fontSize="small" />
                        ) : (
                          <VisibilityOffIcon fontSize="small" />
                        )}
                      </IconButton>
                    </Tooltip>
                    <IconButton
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeRange(range.id);
                      }}
                      sx={{ color: "text.secondary" }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            )}

            {status === "error" && error ? (
              <Typography variant="caption" color="error">
                {error}
              </Typography>
            ) : null}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="inherit" size="small" disabled={isSaving}>
          Cancel
        </Button>
        <Button
          onClick={() => void save()}
          variant="contained"
          size="small"
          disabled={isSaving || !source}
          startIcon={isSaving ? <CircularProgress size={14} /> : undefined}
        >
          {isSaving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
