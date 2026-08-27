import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AudiotrackIcon from "@mui/icons-material/Audiotrack";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CancelIcon from "@mui/icons-material/Cancel";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import TimerIcon from "@mui/icons-material/Timer";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import { postHostToast } from "../../../core/shell/notificationCenter";
import {
  useTimelineClip,
  useTimelineTracks,
} from "../../timeline/api";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import { revealAssetInBrowser } from "../../userAssets/useAssetBrowserRevealStore";
import { extractTimelineClipAudioAsset } from "../../timeline/utils/clipAudioExtraction";
import { cancelSeparationJob } from "../services/samAudioApi";
import {
  CapabilityFailureNotice,
  failureHeadline,
  useRuntimeCapability,
  useRuntimeCapabilityStore,
} from "../../runtimeCapabilities";
import { RUNTIME_CAPABILITY_IDS } from "../../../types/RuntimeStatus";
import {
  isSamAudioAbortError,
  runSamAudioSeparation,
  samAudioFailureCode,
} from "../services/runSamAudioSeparation";
import {
  insertExtractedAudioClipBelowSource,
  muteSourceClipAudio,
} from "../services/extractionTimelinePlacement";
import { useSamAudioExtractDialogStore } from "../store/useSamAudioExtractDialogStore";
import { SamAudioModelDownloadOverlay } from "./SamAudioModelDownloadOverlay";

const SUCCESS_TOAST_DURATION_MS = 2_500;

function getOrderedRange(startTick: number, endTick: number): {
  startTick: number;
  endTick: number;
} {
  return {
    startTick: Math.min(startTick, endTick),
    endTick: Math.max(startTick, endTick),
  };
}

function createSeedRangeForClip(clip: TimelineClip): {
  startTick: number;
  endTick: number;
} {
  const clipStart = Math.max(0, clip.start);
  const clipEnd = Math.max(clipStart + 1, clip.start + clip.timelineDuration);
  const maxSeedDuration = Math.max(1, Math.min(TICKS_PER_SECOND, clipEnd - clipStart));
  const playbackTime = Number.isFinite(playbackClock.time)
    ? playbackClock.time
    : clipStart;
  const seedStart =
    playbackTime >= clipStart && playbackTime < clipEnd
      ? playbackTime
      : clipStart;
  const startTick = Math.min(seedStart, clipEnd - maxSeedDuration);
  return {
    startTick,
    endTick: Math.min(clipEnd, startTick + maxSeedDuration),
  };
}

function formatRangeSummary(range: { startTick: number; endTick: number }) {
  const ordered = getOrderedRange(range.startTick, range.endTick);
  return `${tickToMediaSeconds(ordered.startTick).toFixed(2)}s - ${tickToMediaSeconds(
    ordered.endTick,
  ).toFixed(2)}s`;
}

export function SamAudioExtractDialog() {
  const {
    open,
    view,
    clipId,
    promptText,
    range,
    error,
    statusMessage,
    progress,
    activeJobId,
    cancelRequested,
    close,
    showConfigure,
    showProcessing,
    hideForTimelineSelection,
    reopenConfigure,
    setPromptText,
    setRange,
    setError,
    setProgressState,
    setActiveJobId,
    setCancelRequested,
  } = useSamAudioExtractDialogStore(
    useShallow((state) => ({
      open: state.open,
      view: state.view,
      clipId: state.clipId,
      promptText: state.promptText,
      range: state.range,
      error: state.error,
      statusMessage: state.statusMessage,
      progress: state.progress,
      activeJobId: state.activeJobId,
      cancelRequested: state.cancelRequested,
      close: state.close,
      showConfigure: state.showConfigure,
      showProcessing: state.showProcessing,
      hideForTimelineSelection: state.hideForTimelineSelection,
      reopenConfigure: state.reopenConfigure,
      setPromptText: state.setPromptText,
      setRange: state.setRange,
      setError: state.setError,
      setProgressState: state.setProgressState,
      setActiveJobId: state.setActiveJobId,
      setCancelRequested: state.setCancelRequested,
    })),
  );
  const [isExtractingAll, setIsExtractingAll] = useState(false);
  const operationAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const clip = useTimelineClip(clipId) ?? null;
  const timelineTracks = useTimelineTracks();
  const track = useMemo(
    () =>
      clip !== null
        ? timelineTracks.find((candidate) => candidate.id === clip.trackId) ??
          null
        : null,
    [clip, timelineTracks],
  );
  // One shared source of runtime truth. The dialog used to read
  // /sam-audio/health and fall back to `runtime.error`, a key the backend
  // never set — so every failure rendered as "No SAM-Audio model configured",
  // including the ones where the model was present and the package was not.
  const samAudio = useRuntimeCapability(RUNTIME_CAPABILITY_IDS.samAudio, {
    enabled: open && view === "configure",
  });
  const availability = samAudio.checking
    ? "checking"
    : samAudio.canAttempt
      ? "available"
      : "unavailable";

  const hasPrompt = promptText.trim().length > 0;
  const hasRange = range !== null;
  const canRunSeparation =
    clipId !== null &&
    availability === "available" &&
    view !== "processing" &&
    (hasPrompt || hasRange);
  const progressPercent = Math.round(progress * 100);

  useEffect(() => {
    activeJobIdRef.current = activeJobId;
  }, [activeJobId]);

  useEffect(
    () => () => {
      operationAbortRef.current?.abort();
    },
    [],
  );

  const handleClose = useCallback(() => {
    if (view === "processing") return;
    close();
  }, [close, view]);

  const handleExtractAll = useCallback(async () => {
    if (
      clip === null ||
      track === null ||
      clip.type !== "video" ||
      isExtractingAll
    ) {
      return;
    }

    setError(null);
    setIsExtractingAll(true);
    try {
      const extractedAsset = await extractTimelineClipAudioAsset(
        clip,
        track as TimelineTrack,
      );
      if (!extractedAsset) {
        window.alert("No audio track was found for the selected clip.");
        return;
      }
      const insertedClipId = insertExtractedAudioClipBelowSource(
        clip,
        extractedAsset,
      );
      if (!insertedClipId) {
        throw new Error("Failed to add extracted audio to the timeline.");
      }
      muteSourceClipAudio(clip.id);
      revealAssetInBrowser(extractedAsset.id);
      // The shell notification centre, not a snackbar local to this dialog:
      // the dialog closes on the next line, and the confirmation should
      // outlive it wherever the user looks next.
      postHostToast(
        "Audio Extracted to Timeline and Asset Browser",
        "success",
        SUCCESS_TOAST_DURATION_MS,
      );
      close();
    } catch (extractError) {
      window.alert(
        extractError instanceof Error
          ? extractError.message
          : "Failed to extract clip audio.",
      );
    } finally {
      setIsExtractingAll(false);
    }
  }, [clip, close, isExtractingAll, setError, track]);

  const handleSelectRange = useCallback(() => {
    if (clip === null) return;

    const seedRange = createSeedRangeForClip(clip);
    useExtractStore.getState().setOnConfirmSelection(() => {
      const selectionStore = useTimelineSelectionStore.getState();
      const ordered = getOrderedRange(
        selectionStore.selectionStartTick,
        selectionStore.selectionEndTick,
      );
      selectionStore.exitSelectionMode();
      useExtractStore.getState().setOnConfirmSelection(null);
      setRange(ordered);
      reopenConfigure();
    });
    hideForTimelineSelection();
    useTimelineSelectionStore.getState().enterSelectionMode(
      seedRange.startTick,
      seedRange.endTick,
      {
        message: "Choose the timeline range to use as the SAM-Audio prompt.",
      },
    );
  }, [clip, hideForTimelineSelection, reopenConfigure, setRange]);

  const handleRunSeparation = useCallback(async () => {
    if (!clipId || view === "processing") return;
    if (!hasPrompt && !hasRange) {
      setError("Add a text prompt or select a timeline range first.");
      return;
    }

    operationAbortRef.current?.abort();
    const abortController = new AbortController();
    operationAbortRef.current = abortController;
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setCancelRequested(false);
    showProcessing();

    try {
      await runSamAudioSeparation({
        clipId,
        textPrompt: promptText,
        spanSelection: range,
        signal: abortController.signal,
        onProgress: setProgressState,
        onJobStatus: (status) => {
          activeJobIdRef.current = status.jobId;
          setActiveJobId(status.jobId);
          setProgressState({
            message: status.message ?? status.status,
            progress: status.progress,
          });
        },
      });
      close();
    } catch (separationError) {
      if (isSamAudioAbortError(separationError)) {
        showConfigure();
        return;
      }
      // Returning to configuration clears stale errors, so transition first and
      // then expose the backend's actionable model/dependency diagnostic.
      showConfigure();
      const failureCode = samAudioFailureCode(separationError);
      if (failureCode) {
        // The runtime failed, not this request. The registry has already
        // recorded it, so re-reading turns the configure view into the same
        // classified failure and remedy the diagnostics view shows.
        void useRuntimeCapabilityStore.getState().reload();
        setError(`SAM-Audio unavailable: ${failureHeadline(failureCode)}.`);
      } else {
        setError(
          separationError instanceof Error
            ? separationError.message
            : "SAM-Audio separation failed.",
        );
      }
    } finally {
      operationAbortRef.current = null;
      activeJobIdRef.current = null;
      setActiveJobId(null);
      setCancelRequested(false);
    }
  }, [
    clipId,
    close,
    hasPrompt,
    hasRange,
    promptText,
    range,
    setActiveJobId,
    setCancelRequested,
    setError,
    setProgressState,
    showConfigure,
    showProcessing,
    view,
  ]);

  const handleCancelProcessing = useCallback(async () => {
    if (cancelRequested) return;
    setCancelRequested(true);
    operationAbortRef.current?.abort();
    const jobId = activeJobIdRef.current;
    if (jobId) {
      try {
        await cancelSeparationJob(jobId);
      } catch (cancelError) {
        setError(
          cancelError instanceof Error
            ? `Cancel failed: ${cancelError.message}`
            : "Cancel failed.",
        );
      }
    }
  }, [cancelRequested, setCancelRequested, setError]);

  const title = useMemo(() => {
    if (view === "configure") return "Extract Selection";
    if (view === "processing") return "Isolating Sound";
    return "Extract Audio";
  }, [view]);

  return (
    <>
      <Dialog
        open={open}
        onClose={handleClose}
        maxWidth="sm"
        fullWidth
        aria-labelledby="sam-audio-extract-dialog-title"
      >
        <DialogTitle id="sam-audio-extract-dialog-title">{title}</DialogTitle>
        <DialogContent
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            // Children must keep their intrinsic height: a shrunk child
            // overflows its box and paints over whatever follows it.
            "& > *": { flexShrink: 0 },
          }}
        >
          {clip === null ? (
            <Alert severity="warning">The source clip is no longer available.</Alert>
          ) : null}
          {view === "choose" ? (
            <Stack spacing={1.25} sx={{ pt: 0.5 }}>
              <Button
                variant="outlined"
                startIcon={<AudiotrackIcon />}
                onClick={() => {
                  void handleExtractAll();
                }}
                disabled={clip === null || isExtractingAll}
                sx={{
                  justifyContent: "flex-start",
                  minHeight: 48,
                  textTransform: "none",
                }}
              >
                {isExtractingAll ? "Extracting..." : "Extract All"}
              </Button>
              <Button
                variant="outlined"
                startIcon={<CallSplitIcon />}
                onClick={showConfigure}
                disabled={clip === null || isExtractingAll}
                sx={{
                  justifyContent: "flex-start",
                  minHeight: 48,
                  textTransform: "none",
                }}
              >
                Extract Selection
              </Button>
            </Stack>
          ) : null}

          {view === "configure" ? (
            <>
              {availability === "checking" ? (
                <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                  <LinearProgress />
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    Checking the SAM-Audio runtime
                  </Typography>
                </Box>
              ) : null}

              {/* Without a runtime there is nothing to configure, so this
                  replaces the prompt form rather than sharing the dialog with
                  controls that cannot be used yet. Which remedy is offered
                  depends on the classified failure: the download panel appears
                  only for missing model files, never for a missing package it
                  could not install. */}
              {availability === "unavailable" ? (
                <CapabilityFailureNotice
                  capabilityId={RUNTIME_CAPABILITY_IDS.samAudio}
                  capabilityLabel="SAM-Audio"
                  failure={samAudio.failure}
                  lastFailure={samAudio.capability?.lastFailure ?? null}
                  fallbackMessage={
                    samAudio.message ?? "SAM-Audio is not available."
                  }
                  downloadSurface={
                    <SamAudioModelDownloadOverlay
                      onModelsInstalled={samAudio.recheck}
                    />
                  }
                />
              ) : null}

              {availability === "available" ? (
                <>
                  {error ? <Alert severity="error">{error}</Alert> : null}
                  <TextField
                    label="Text prompt"
                    placeholder="man speaking"
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                    size="small"
                    fullWidth
                    sx={{ mt: 0.5 }}
                  />
                  <Box
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 1,
                      border: "1px solid",
                      borderColor: "divider",
                      borderRadius: 1,
                      p: 1.25,
                    }}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <TimerIcon fontSize="small" color="primary" />
                      <Typography variant="subtitle2">Timeline range</Typography>
                    </Box>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {range ? formatRangeSummary(range) : "No range selected"}
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="outlined"
                        onClick={handleSelectRange}
                        size="small"
                        sx={{ textTransform: "none" }}
                      >
                        Select Range
                      </Button>
                      <Button
                        variant="text"
                        onClick={() => setRange(null)}
                        size="small"
                        disabled={!range}
                        sx={{ textTransform: "none" }}
                      >
                        Clear Range
                      </Button>
                    </Stack>
                  </Box>
                  <Divider />
                  {!hasPrompt && !hasRange ? (
                    <Alert severity="info">
                      Add a text prompt, select a timeline range, or use both.
                    </Alert>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {view === "processing" ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <GraphicEqIcon color="primary" fontSize="small" />
                <Typography variant="body2">
                  {statusMessage || "Running SAM-Audio separation"}
                </Typography>
              </Box>
              <LinearProgress variant="determinate" value={progressPercent} />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {progressPercent}%
              </Typography>
              {error ? <Alert severity="error">{error}</Alert> : null}
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          {view === "processing" ? (
            <Button
              color="error"
              startIcon={<CancelIcon />}
              onClick={() => {
                void handleCancelProcessing();
              }}
              disabled={cancelRequested}
              sx={{ textTransform: "none" }}
            >
              {cancelRequested ? "Cancelling..." : "Cancel"}
            </Button>
          ) : (
            <Button onClick={handleClose} sx={{ textTransform: "none" }}>
              Cancel
            </Button>
          )}
          {view === "configure" && availability === "available" ? (
            <Button
              variant="contained"
              startIcon={<CallSplitIcon />}
              onClick={() => {
                void handleRunSeparation();
              }}
              disabled={!canRunSeparation}
              sx={{ textTransform: "none" }}
            >
              Isolate Sound
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </>
  );
}
