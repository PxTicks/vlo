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
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { mediaSecondsToTick, tickToMediaSeconds } from "../../core/time";
import { useMiniEditorStore } from "./useMiniEditorStore";
import { EditorTrack } from "./components/EditorTrack";

function formatTicks(ticks: number): string {
  const totalSeconds = tickToMediaSeconds(Math.max(0, ticks));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centis = Math.floor((totalSeconds % 1) * 100);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${centis
    .toString()
    .padStart(2, "0")}`;
}

export function MiniEditorModal() {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const isOpen = useMiniEditorStore((s) => s.isOpen);
  const title = useMiniEditorStore((s) => s.title);
  const status = useMiniEditorStore((s) => s.status);
  const error = useMiniEditorStore((s) => s.error);
  const notice = useMiniEditorStore((s) => s.notice);
  const source = useMiniEditorStore((s) => s.source);
  const durationTicks = useMiniEditorStore((s) => s.durationTicks);
  const cropStartTicks = useMiniEditorStore((s) => s.cropStartTicks);
  const cropEndTicks = useMiniEditorStore((s) => s.cropEndTicks);
  const ranges = useMiniEditorStore((s) => s.ranges);
  const selectedRangeId = useMiniEditorStore((s) => s.selectedRangeId);
  const playheadTicks = useMiniEditorStore((s) => s.playheadTicks);
  const isPlaying = useMiniEditorStore((s) => s.isPlaying);
  const extractionMode = useMiniEditorStore((s) => s.extractionMode);

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
  const beginRangeExtraction = useMiniEditorStore(
    (s) => s.beginRangeExtraction,
  );
  const beginFrameExtraction = useMiniEditorStore(
    (s) => s.beginFrameExtraction,
  );
  const cancelExtractionSelection = useMiniEditorStore(
    (s) => s.cancelExtractionSelection,
  );
  const extractRange = useMiniEditorStore((s) => s.extractRange);
  const extractFrame = useMiniEditorStore((s) => s.extractFrame);
  const canSave = useMiniEditorStore((s) => Boolean(s._internal.onSave));
  const canExtractRange = useMiniEditorStore((s) =>
    Boolean(s._internal.onExtractRange),
  );
  const canExtractFrame = useMiniEditorStore((s) =>
    Boolean(s._internal.onExtractFrame),
  );
  const onPrevious = useMiniEditorStore((s) => s._internal.onPrevious);
  const onNext = useMiniEditorStore((s) => s._internal.onNext);
  const hasPrevious = useMiniEditorStore((s) => s._internal.hasPrevious);
  const hasNext = useMiniEditorStore((s) => s._internal.hasNext);
  const autoPlay = useMiniEditorStore((s) => s._internal.autoPlay);

  const isBusy =
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame";
  const mediaType = source?.mediaType ?? "video";
  const isTemporal = mediaType === "video" || mediaType === "audio";
  const isSelectingExtraction = extractionMode !== null;
  const attachMedia = useCallback((media: HTMLMediaElement | null) => {
    mediaRef.current = media;
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isBusy || isSelectingExtraction) return;
      if (event.key === "ArrowLeft" && hasPrevious && onPrevious) {
        event.preventDefault();
        onPrevious();
      } else if (event.key === "ArrowRight" && hasNext && onNext) {
        event.preventDefault();
        onNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    hasNext,
    hasPrevious,
    isBusy,
    isOpen,
    isSelectingExtraction,
    onNext,
    onPrevious,
  ]);

  // Pause playback whenever we leave the "ready" state.
  useEffect(() => {
    if (status !== "ready" && isPlaying) {
      setPlaying(false);
    }
  }, [status, isPlaying, setPlaying]);

  // Drive the <video> position from the playhead while paused / scrubbing.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || isPlaying) return;
    const target = tickToMediaSeconds(playheadTicks);
    if (Math.abs(media.currentTime - target) > 0.02) {
      media.currentTime = target;
    }
  }, [playheadTicks, isPlaying]);

  // Playback loop: follow the video clock and loop within the crop window.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    if (!isPlaying) {
      media.pause();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const cropStartSec = tickToMediaSeconds(cropStartTicks);
    const cropEndSec = tickToMediaSeconds(cropEndTicks);
    if (media.currentTime < cropStartSec || media.currentTime >= cropEndSec) {
      media.currentTime = cropStartSec;
    }
    void media.play().catch(() => undefined);

    const tick = () => {
      const current = mediaRef.current;
      if (!current) return;
      if (current.currentTime >= cropEndSec) {
        current.currentTime = cropStartSec;
      }
      setPlayhead(mediaSecondsToTick(current.currentTime));
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
    if (isBusy) return;
    if (isSelectingExtraction) {
      cancelExtractionSelection();
      return;
    }
    close();
  }, [cancelExtractionSelection, close, isBusy, isSelectingExtraction]);

  const cropLabel = `${formatTicks(cropEndTicks - cropStartTicks)} (${formatTicks(
    cropStartTicks,
  )} – ${formatTicks(cropEndTicks)})`;

  const syncPlayheadFromMedia = useCallback(
    (media: HTMLMediaElement) => {
      setPlayhead(mediaSecondsToTick(media.currentTime));
    },
    [setPlayhead],
  );

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
              Preparing asset…
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
              {mediaType === "image" ? (
                <img
                  src={source?.sourceUrl}
                  alt={title}
                  style={{
                    maxHeight: 480,
                    maxWidth: "100%",
                    objectFit: "contain",
                  }}
                />
              ) : mediaType === "lut" ? (
                <Stack alignItems="center" spacing={1} sx={{ py: 8, px: 3 }}>
                  <Typography variant="body2">LUT asset</Typography>
                  <Typography variant="caption" color="text.secondary">
                    This asset has no visual preview.
                  </Typography>
                </Stack>
              ) : mediaType === "audio" ? (
                <Box sx={{ width: "100%", px: 3, py: 5 }}>
                  <audio
                    ref={attachMedia}
                    src={source?.sourceUrl}
                    controls
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    onSeeked={(event) =>
                      syncPlayheadFromMedia(event.currentTarget)
                    }
                    style={{ display: "block", width: "100%" }}
                  />
                </Box>
              ) : (
                <video
                  ref={attachMedia}
                  src={source?.sourceUrl}
                  playsInline
                  controls
                  autoPlay={autoPlay}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onSeeked={(event) =>
                    syncPlayheadFromMedia(event.currentTarget)
                  }
                  style={{ maxHeight: 360, maxWidth: "100%" }}
                  onLoadedMetadata={(event) => {
                    const el = event.currentTarget;
                    setSourceDimensions(el.videoWidth, el.videoHeight);
                  }}
                />
              )}
              {onPrevious || onNext ? (
                <>
                  <IconButton
                    aria-label="Previous asset"
                    onClick={onPrevious ?? undefined}
                    disabled={!hasPrevious || isBusy || isSelectingExtraction}
                    sx={{
                      position: "absolute",
                      left: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "white",
                      bgcolor: "rgba(0,0,0,0.45)",
                    }}
                  >
                    <ChevronLeftIcon />
                  </IconButton>
                  <IconButton
                    aria-label="Next asset"
                    onClick={onNext ?? undefined}
                    disabled={!hasNext || isBusy || isSelectingExtraction}
                    sx={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "white",
                      bgcolor: "rgba(0,0,0,0.45)",
                    }}
                  >
                    <ChevronRightIcon />
                  </IconButton>
                </>
              ) : null}
            </Box>

            {isTemporal ? (
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatTicks(playheadTicks)} / {formatTicks(durationTicks)}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {canSave ? (
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={addRangeAtPlayhead}
                    sx={{ color: "#f4a0a0" }}
                  >
                    Add range mask
                  </Button>
                ) : null}
              </Stack>
            ) : null}

            {isTemporal ? (
              extractionMode ? (
                <Box
                  role="status"
                  sx={{
                    px: 1.5,
                    py: 1,
                    borderRadius: 1,
                    bgcolor: "rgba(33, 150, 243, 0.12)",
                    border: "1px solid rgba(144, 202, 249, 0.35)",
                  }}
                >
                  <Typography variant="body2" fontWeight={600}>
                    {extractionMode === "range"
                      ? "Select the range to extract"
                      : "Select the frame to extract"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {extractionMode === "range"
                      ? "Drag the blue start and end handles, then confirm the extraction."
                      : "Drag the playhead or click the track, then confirm the extraction."}
                  </Typography>
                </Box>
              ) : null
            ) : null}

            {isTemporal ? (
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
                extractionMode={extractionMode}
              />
            ) : null}

            {isTemporal ? (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {canSave ? "Crop" : "Selection"}: {cropLabel}
              </Typography>
            ) : null}

            {canSave && ranges.length > 0 && (
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
                        aria-label={
                          range.isActive
                            ? `Disable mask ${index + 1}`
                            : `Enable mask ${index + 1}`
                        }
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
                      aria-label={`Delete mask ${index + 1}`}
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
            {notice ? (
              <Typography variant="caption" color="success.main">
                {notice}
              </Typography>
            ) : null}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {isSelectingExtraction ? (
          <Button
            onClick={cancelExtractionSelection}
            color="inherit"
            size="small"
            disabled={isBusy}
          >
            Cancel selection
          </Button>
        ) : (
          <Button
            onClick={handleClose}
            color="inherit"
            size="small"
            disabled={isBusy}
          >
            {canSave ? "Cancel" : "Close"}
          </Button>
        )}
        {canExtractFrame && extractionMode === null ? (
          <Button
            onClick={beginFrameExtraction}
            variant="outlined"
            size="small"
            disabled={isBusy || !source}
            startIcon={<CameraAltIcon />}
          >
            Extract frame
          </Button>
        ) : null}
        {canExtractRange && extractionMode === null ? (
          <Button
            onClick={beginRangeExtraction}
            variant="contained"
            size="small"
            disabled={isBusy || !source}
            startIcon={<ContentCutIcon />}
          >
            Extract range
          </Button>
        ) : null}
        {extractionMode === "frame" ? (
          <Button
            onClick={() => void extractFrame()}
            variant="contained"
            size="small"
            disabled={isBusy || !source}
            startIcon={
              status === "extracting-frame" ? (
                <CircularProgress size={14} />
              ) : (
                <CameraAltIcon />
              )
            }
          >
            {status === "extracting-frame"
              ? "Extracting…"
              : "Confirm frame extraction"}
          </Button>
        ) : null}
        {extractionMode === "range" ? (
          <Button
            onClick={() => void extractRange()}
            variant="contained"
            size="small"
            disabled={isBusy || !source}
            startIcon={
              status === "extracting-range" ? (
                <CircularProgress size={14} />
              ) : (
                <ContentCutIcon />
              )
            }
          >
            {status === "extracting-range"
              ? "Extracting…"
              : "Confirm range extraction"}
          </Button>
        ) : null}
        {canSave ? (
          <Button
            onClick={() => void save()}
            variant="contained"
            size="small"
            disabled={isBusy || !source}
            startIcon={
              status === "saving" ? <CircularProgress size={14} /> : undefined
            }
          >
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
