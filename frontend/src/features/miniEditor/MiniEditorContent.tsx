import { useCallback, useEffect, useRef } from "react";
import AddIcon from "@mui/icons-material/Add";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { mediaSecondsToTick, tickToMediaSeconds } from "../../core/time";
import { EditorTrack } from "./components/EditorTrack";
import { useMiniEditorStore } from "./useMiniEditorStore";

function formatTicks(ticks: number): string {
  const totalSeconds = tickToMediaSeconds(Math.max(0, ticks));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centis = Math.floor((totalSeconds % 1) * 100);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${centis
    .toString()
    .padStart(2, "0")}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

interface MiniEditorPreviewProps {
  readonly fillStage?: boolean;
}

/** Shared preview/controller used by both the modal and workspace surface. */
export function MiniEditorPreview({ fillStage = false }: MiniEditorPreviewProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const isOpen = useMiniEditorStore((state) => state.isOpen);
  const title = useMiniEditorStore((state) => state.title);
  const status = useMiniEditorStore((state) => state.status);
  const error = useMiniEditorStore((state) => state.error);
  const source = useMiniEditorStore((state) => state.source);
  const playheadTicks = useMiniEditorStore((state) => state.playheadTicks);
  const isPlaying = useMiniEditorStore((state) => state.isPlaying);
  const cropStartTicks = useMiniEditorStore((state) => state.cropStartTicks);
  const cropEndTicks = useMiniEditorStore((state) => state.cropEndTicks);
  const extractionMode = useMiniEditorStore((state) => state.extractionMode);
  const setSourceDimensions = useMiniEditorStore(
    (state) => state.setSourceDimensions,
  );
  const setPlayhead = useMiniEditorStore((state) => state.setPlayhead);
  const setPlaying = useMiniEditorStore((state) => state.setPlaying);
  const onPrevious = useMiniEditorStore(
    (state) => state._internal.onPrevious,
  );
  const onNext = useMiniEditorStore((state) => state._internal.onNext);
  const hasPrevious = useMiniEditorStore(
    (state) => state._internal.hasPrevious,
  );
  const hasNext = useMiniEditorStore((state) => state._internal.hasNext);
  const autoPlay = useMiniEditorStore((state) => state._internal.autoPlay);

  const isBusy =
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame";
  const isSelectingExtraction = extractionMode !== null;
  const mediaType = source?.mediaType ?? "video";
  const attachMedia = useCallback((media: HTMLMediaElement | null) => {
    mediaRef.current = media;
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isBusy || isSelectingExtraction) return;
      if (isEditableTarget(event.target)) return;
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

  useEffect(() => {
    if (status !== "ready" && isPlaying) setPlaying(false);
  }, [isPlaying, setPlaying, status]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || isPlaying) return;
    const target = tickToMediaSeconds(playheadTicks);
    if (Math.abs(media.currentTime - target) > 0.02) media.currentTime = target;
  }, [isPlaying, playheadTicks]);

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
      if (current.currentTime >= cropEndSec) current.currentTime = cropStartSec;
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
  }, [cropEndTicks, cropStartTicks, isPlaying, setPlayhead]);

  const syncPlayheadFromMedia = useCallback(
    (media: HTMLMediaElement) => {
      setPlayhead(mediaSecondsToTick(media.currentTime));
    },
    [setPlayhead],
  );

  if (status === "preparing") {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        spacing={2}
        sx={{ py: 6, ...(fillStage ? { flex: 1 } : {}) }}
      >
        <CircularProgress size={28} />
        <Typography variant="body2" color="text.secondary">
          Preparing asset…
        </Typography>
      </Stack>
    );
  }
  if (status === "error" && !source) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        spacing={1}
        sx={{ py: 6, ...(fillStage ? { flex: 1 } : {}) }}
      >
        <Typography variant="body2" color="error">
          {error ?? "Failed to load the video."}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box
      data-testid="mini-editor-preview"
      sx={{
        position: "relative",
        bgcolor: "#000",
        borderRadius: fillStage ? 0 : 1,
        overflow: "hidden",
        display: "flex",
        flex: fillStage ? 1 : undefined,
        minHeight: 0,
        alignItems: "center",
        justifyContent: "center",
        maxHeight: fillStage ? "100%" : 360,
      }}
    >
      {mediaType === "image" ? (
        <img
          src={source?.sourceUrl}
          alt={title}
          style={{
            // Must not exceed the container's own cap: the stage clips
            // overflow, so a taller image loses its top and bottom bands.
            maxHeight: fillStage ? "100%" : 360,
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
            onSeeked={(event) => syncPlayheadFromMedia(event.currentTarget)}
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
          onSeeked={(event) => syncPlayheadFromMedia(event.currentTarget)}
          style={{
            maxHeight: fillStage ? "100%" : 360,
            maxWidth: "100%",
          }}
          onLoadedMetadata={(event) => {
            const media = event.currentTarget;
            setSourceDimensions(media.videoWidth, media.videoHeight);
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
  );
}

/** Shared clip-local track and controls; no project timeline assumptions. */
export function MiniEditorControls() {
  const status = useMiniEditorStore((state) => state.status);
  const error = useMiniEditorStore((state) => state.error);
  const notice = useMiniEditorStore((state) => state.notice);
  const source = useMiniEditorStore((state) => state.source);
  const durationTicks = useMiniEditorStore((state) => state.durationTicks);
  const cropStartTicks = useMiniEditorStore((state) => state.cropStartTicks);
  const cropEndTicks = useMiniEditorStore((state) => state.cropEndTicks);
  const ranges = useMiniEditorStore((state) => state.ranges);
  const selectedRangeId = useMiniEditorStore(
    (state) => state.selectedRangeId,
  );
  const playheadTicks = useMiniEditorStore((state) => state.playheadTicks);
  const extractionMode = useMiniEditorStore((state) => state.extractionMode);
  const setCrop = useMiniEditorStore((state) => state.setCrop);
  const addRangeAtPlayhead = useMiniEditorStore(
    (state) => state.addRangeAtPlayhead,
  );
  const updateRange = useMiniEditorStore((state) => state.updateRange);
  const removeRange = useMiniEditorStore((state) => state.removeRange);
  const toggleRange = useMiniEditorStore((state) => state.toggleRange);
  const selectRange = useMiniEditorStore((state) => state.selectRange);
  const setPlayhead = useMiniEditorStore((state) => state.setPlayhead);
  const canSave = useMiniEditorStore((state) =>
    Boolean(state._internal.onSave),
  );

  if (status === "preparing" || (status === "error" && !source)) return null;
  const mediaType = source?.mediaType ?? "video";
  const isTemporal = mediaType === "video" || mediaType === "audio";
  const cropLabel = `${formatTicks(cropEndTicks - cropStartTicks)} (${formatTicks(
    cropStartTicks,
  )} – ${formatTicks(cropEndTicks)})`;

  return (
    <Stack spacing={2} data-testid="mini-editor-controls">
      {isTemporal ? (
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
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

      {isTemporal && extractionMode ? (
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

      {canSave && ranges.length > 0 ? (
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
      ) : null}

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
  );
}

interface MiniEditorActionsProps {
  readonly onRequestClose: () => void;
}

/** Shared task actions; the containing presentation owns how closing happens. */
export function MiniEditorActions({ onRequestClose }: MiniEditorActionsProps) {
  const status = useMiniEditorStore((state) => state.status);
  const source = useMiniEditorStore((state) => state.source);
  const extractionMode = useMiniEditorStore((state) => state.extractionMode);
  const save = useMiniEditorStore((state) => state.save);
  const beginRangeExtraction = useMiniEditorStore(
    (state) => state.beginRangeExtraction,
  );
  const beginFrameExtraction = useMiniEditorStore(
    (state) => state.beginFrameExtraction,
  );
  const cancelExtractionSelection = useMiniEditorStore(
    (state) => state.cancelExtractionSelection,
  );
  const closeOnExtractionCancel = useMiniEditorStore(
    (state) => state._internal.closeOnExtractionCancel,
  );
  const extractRange = useMiniEditorStore((state) => state.extractRange);
  const extractFrame = useMiniEditorStore((state) => state.extractFrame);
  const canSave = useMiniEditorStore((state) =>
    Boolean(state._internal.onSave),
  );
  const canExtractRange = useMiniEditorStore((state) =>
    Boolean(state._internal.onExtractRange),
  );
  const canExtractFrame = useMiniEditorStore((state) =>
    Boolean(state._internal.onExtractFrame),
  );
  const isBusy =
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame";

  return (
    <>
      {extractionMode ? (
        <Button
          onClick={
            closeOnExtractionCancel
              ? onRequestClose
              : cancelExtractionSelection
          }
          color="inherit"
          size="small"
          disabled={isBusy}
        >
          Cancel selection
        </Button>
      ) : (
        <Button
          onClick={onRequestClose}
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
    </>
  );
}
