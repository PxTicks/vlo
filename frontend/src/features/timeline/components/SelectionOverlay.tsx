import { useCallback, useRef, useState, useEffect } from "react";
import { Box, Button, Paper, Typography } from "@mui/material";
import { useExtractStore } from "../../player/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useProjectStore } from "../../project";
import { playbackClock } from "../../player/services/PlaybackClock";
import { BufferedTextInput } from "../../panelUI/components/BufferedTextInput";
import {
  TRACK_HEADER_WIDTH,
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
} from "../constants";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
  snapTickToFrame,
} from "../../timelineSelection";

export interface SelectionOverlayProps {
  maxSelectionTicks?: number | null;
  recommendedMaxTicks?: number | null;
  recommendedFps?: number | null;
  recommendedFrameStep?: number | null;
}

export function SelectionOverlay({
  maxSelectionTicks = null,
  recommendedMaxTicks,
  recommendedFps,
  recommendedFrameStep,
}: SelectionOverlayProps) {
  const selectionMode = useTimelineSelectionStore((s) => s.selectionMode);
  const startTick = useTimelineSelectionStore((s) => s.selectionStartTick);
  const endTick = useTimelineSelectionStore((s) => s.selectionEndTick);
  const updateSelectionEnd = useTimelineSelectionStore((s) => s.updateSelectionEnd);
  const selectionFpsOverride = useTimelineSelectionStore(
    (s) => s.selectionFpsOverride,
  );
  const selectionFrameStep = useTimelineSelectionStore((s) => s.selectionFrameStep);
  const recommendedFpsFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedFps,
  );
  const recommendedFrameStepFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedFrameStep,
  );
  const recommendedMaxTicksFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedMaxTicks,
  );
  const setSelectionFpsOverride = useTimelineSelectionStore(
    (s) => s.setSelectionFpsOverride,
  );
  const setSelectionFrameStep = useTimelineSelectionStore(
    (s) => s.setSelectionFrameStep,
  );
  const onConfirmSelection = useExtractStore((s) => s.onConfirmSelection);
  const zoomScale = useTimelineViewStore((s) => s.zoomScale);
  const projectFps = useProjectStore((s) => s.config.fps);

  const effectiveFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    projectFps,
  );
  const effectiveFrameStep = resolveSelectionFrameStep({
    frameStep: selectionFrameStep,
  });
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const resolvedRecommendedFps =
    recommendedFps ?? recommendedFpsFromStore ?? null;
  const resolvedRecommendedFrameStep =
    recommendedFrameStep ?? recommendedFrameStepFromStore ?? null;
  const resolvedRecommendedMaxTicks =
    recommendedMaxTicks ?? recommendedMaxTicksFromStore ?? null;

  // `undefined` means follow external limits; `null` means explicitly unbounded.
  const [localMaxTicksOverride, setLocalMaxTicksOverride] = useState<
    number | null | undefined
  >(undefined);
  const localMaxTicks =
    localMaxTicksOverride !== undefined
      ? localMaxTicksOverride
      : (maxSelectionTicks ?? resolvedRecommendedMaxTicks);

  const getMaxFrameCount = useCallback(() => {
    if (localMaxTicks === null) return null;
    return snapFrameCountToStep(
      localMaxTicks / ticksPerFrame,
      effectiveFrameStep,
      "floor",
    );
  }, [effectiveFrameStep, localMaxTicks, ticksPerFrame]);

  const clampFrameCount = useCallback(
    (rawFrameCount: number, mode: "nearest" | "floor" | "ceil" = "floor") => {
      let frameCount = snapFrameCountToStep(rawFrameCount, effectiveFrameStep, mode);
      const maxFrameCount = getMaxFrameCount();
      if (maxFrameCount !== null) {
        frameCount = Math.min(frameCount, maxFrameCount);
      }
      return Math.max(1, frameCount);
    },
    [effectiveFrameStep, getMaxFrameCount],
  );

  // Enforce valid selection size whenever fps/frame-step/max changes.
  useEffect(() => {
    if (!selectionMode) return;

    const rawFrameCount = Math.max(1, (endTick - startTick) / ticksPerFrame);
    const normalizedFrameCount = clampFrameCount(rawFrameCount, "floor");
    const normalizedEndTick = startTick + normalizedFrameCount * ticksPerFrame;

    if (Math.abs(normalizedEndTick - endTick) > 0.01) {
      updateSelectionEnd(normalizedEndTick);
    }
  }, [
    clampFrameCount,
    endTick,
    selectionMode,
    startTick,
    ticksPerFrame,
    updateSelectionEnd,
  ]);

  const draggingRef = useRef<"start" | "end" | "middle" | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<
    "start" | "end" | "middle" | null
  >(null);
  const dragOriginXRef = useRef(0);
  const dragOriginTickRef = useRef(0);

  const ticksToPx = useCallback(
    (ticks: number) =>
      (ticks / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale,
    [zoomScale],
  );

  const pxToTicks = useCallback(
    (px: number) => {
      const safeScale = Math.max(0.001, zoomScale);
      return (px / (PIXELS_PER_SECOND * safeScale)) * TICKS_PER_SECOND;
    },
    [zoomScale],
  );

  const handlePointerDown = useCallback(
    (handle: "start" | "end" | "middle", e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = handle;
      setDraggingHandle(handle);

      const scrollContainer = useTimelineViewStore.getState().scrollContainer;
      const rect = scrollContainer?.getBoundingClientRect();
      const scrollLeft = scrollContainer?.scrollLeft ?? 0;
      dragOriginXRef.current =
        e.clientX - (rect?.left ?? 0) + scrollLeft - TRACK_HEADER_WIDTH;

      const { selectionStartTick, selectionEndTick } =
        useTimelineSelectionStore.getState();

      dragOriginTickRef.current =
        handle === "start"
          ? selectionStartTick
          : handle === "end"
            ? selectionEndTick
            : selectionStartTick; // anchor on start tick for middle drag

      playbackClock.setTime(dragOriginTickRef.current);

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;

      const scrollContainer = useTimelineViewStore.getState().scrollContainer;
      const rect = scrollContainer?.getBoundingClientRect();
      const scrollLeft = scrollContainer?.scrollLeft ?? 0;
      const currentX =
        e.clientX - (rect?.left ?? 0) + scrollLeft - TRACK_HEADER_WIDTH;

      const deltaPx = currentX - dragOriginXRef.current;
      const deltaTicks = pxToTicks(deltaPx);

      const {
        selectionStartTick,
        selectionEndTick,
        updateSelectionStart,
        updateSelectionEnd,
      } = useTimelineSelectionStore.getState();

      if (draggingRef.current === "start") {
        const rawStartTick = Math.max(0, dragOriginTickRef.current + deltaTicks);
        const rawFrameCount =
          (selectionEndTick - rawStartTick) / Math.max(1e-6, ticksPerFrame);
        const frameCount = clampFrameCount(rawFrameCount, "floor");
        const finalTick = Math.max(
          0,
          selectionEndTick - frameCount * ticksPerFrame,
        );

        if (finalTick < selectionEndTick) {
          updateSelectionStart(finalTick);
          playbackClock.setTime(finalTick);
        }
      } else if (draggingRef.current === "end") {
        const rawEndTick = dragOriginTickRef.current + deltaTicks;
        const rawFrameCount =
          (rawEndTick - selectionStartTick) / Math.max(1e-6, ticksPerFrame);
        const frameCount = clampFrameCount(rawFrameCount, "floor");
        const finalTick = selectionStartTick + frameCount * ticksPerFrame;

        if (finalTick > selectionStartTick) {
          updateSelectionEnd(finalTick);
          playbackClock.setTime(finalTick);
        }
      } else if (draggingRef.current === "middle") {
        const rawStartTick = Math.max(0, dragOriginTickRef.current + deltaTicks);
        const snappedStartTick = snapTickToFrame(rawStartTick, ticksPerFrame);
        const durationFrameCount = clampFrameCount(
          (selectionEndTick - selectionStartTick) / Math.max(1e-6, ticksPerFrame),
          "floor",
        );
        const durationTicks = durationFrameCount * ticksPerFrame;
        const newStart = Math.max(0, snappedStartTick);
        const newEnd = newStart + durationTicks;

        updateSelectionStart(newStart);
        updateSelectionEnd(newEnd);
        playbackClock.setTime(newStart);
      }
    },
    [clampFrameCount, pxToTicks, ticksPerFrame],
  );

  const handlePointerUp = useCallback(() => {
    draggingRef.current = null;
    setDraggingHandle(null);
  }, []);

  const handleCancel = useCallback(() => {
    useTimelineSelectionStore.getState().exitSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (onConfirmSelection) onConfirmSelection();
  }, [onConfirmSelection]);

  if (!selectionMode) return null;

  const startPx = ticksToPx(startTick);
  const endPx = ticksToPx(endTick);

  const currentDurationSeconds = (endTick - startTick) / TICKS_PER_SECOND;
  const currentFrameCount = Math.max(
    1,
    Math.round((endTick - startTick) / Math.max(1e-6, ticksPerFrame)),
  );

  // Determine if we should show a warning
  const isOverRecommended =
    resolvedRecommendedMaxTicks !== null &&
    localMaxTicks !== null &&
    localMaxTicks > resolvedRecommendedMaxTicks;

  // Handlers for the Input
  const handleMaxLimitChange = (valStr: string) => {
    if (valStr.trim() === "") {
      setLocalMaxTicksOverride(null); // Unbounded
      return;
    }

    const val = parseFloat(valStr);
    if (!isNaN(val) && val > 0) {
      const rawFrameCount = (val * TICKS_PER_SECOND) / ticksPerFrame;
      const frameCount = snapFrameCountToStep(
        rawFrameCount,
        effectiveFrameStep,
        "floor",
      );
      setLocalMaxTicksOverride(Math.max(ticksPerFrame, frameCount * ticksPerFrame));
      return;
    }

    setLocalMaxTicksOverride(null);
  };

  const handleFpsOverrideChange = (valStr: string) => {
    if (valStr.trim() === "") {
      setSelectionFpsOverride(null);
      return;
    }

    const parsed = parseFloat(valStr);
    if (!isNaN(parsed) && parsed > 0) {
      setSelectionFpsOverride(parsed);
      return;
    }

    setSelectionFpsOverride(null);
  };

  const handleFrameStepChange = (valStr: string) => {
    const parsed = parseInt(valStr, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setSelectionFrameStep(parsed);
      return;
    }

    setSelectionFrameStep(1);
  };

  const dimSx = {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    bgcolor: "rgba(0, 0, 0, 0.6)",
    zIndex: 25,
    pointerEvents: "none" as const,
  };

  const handleSx = {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    width: "8px",
    cursor: "col-resize",
    zIndex: 35,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    "&::after": {
      content: '""',
      width: "2px",
      height: "100%",
      bgcolor: "#4fc3f7",
    },
    "&:hover::after": {
      bgcolor: "#81d4fa",
      width: "3px",
    },
  };

  return (
    <>
      {/* Left dim region */}
      <Box
        sx={{
          ...dimSx,
          left: `${TRACK_HEADER_WIDTH}px`,
          width: `${startPx}px`,
        }}
      />

      {/* Right dim region */}
      <Box
        sx={{
          ...dimSx,
          left: `${TRACK_HEADER_WIDTH + endPx}px`,
          right: 0,
        }}
      />

      {/* Selection highlight border */}
      <Box
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${TRACK_HEADER_WIDTH + startPx}px`,
          width: `${endPx - startPx}px`,
          border: "1px solid rgba(79, 195, 247, 0.3)",
          zIndex: 25,
          cursor: draggingHandle === "middle" ? "grabbing" : "grab",
          // Don't disable pointer events so we can click the area
        }}
        onPointerDown={(e) => handlePointerDown("middle", e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* Start handle */}
      <Box
        sx={{
          ...handleSx,
          left: `${TRACK_HEADER_WIDTH + startPx - 4}px`,
        }}
        onPointerDown={(e) => handlePointerDown("start", e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* End handle */}
      <Box
        sx={{
          ...handleSx,
          left: `${TRACK_HEADER_WIDTH + endPx - 4}px`,
        }}
        onPointerDown={(e) => handlePointerDown("end", e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      <Paper
        sx={{
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          bgcolor: "#222",
          border: "1px solid #444",
          px: 2,
          py: 1,
          display: "flex",
          gap: 1.5,
          alignItems: "center",
          borderRadius: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", mr: 1 }}>
          <Typography variant="body2" sx={{ color: "#aaa", mr: 0.5 }}>
            Duration: {currentDurationSeconds.toFixed(2)}s ({currentFrameCount}f)
          </Typography>
          <BufferedTextInput
            label=""
            value={
              localMaxTicks !== null
                ? (localMaxTicks / TICKS_PER_SECOND).toFixed(2)
                : ""
            }
            placeholder="∞"
            onCommit={handleMaxLimitChange}
            sx={{
              width: 50,
              "& .MuiOutlinedInput-root": {
                height: 24,
                fontSize: "0.875rem",
                color: "#aaa",
                px: 0.5,
                "& fieldset": {
                  border: "none",
                  borderBottom: isOverRecommended ? "1px solid" : "1px dotted",
                  borderColor: isOverRecommended ? "error.main" : "#666",
                  borderRadius: 0,
                },
                "&:hover fieldset": {
                  borderColor: isOverRecommended ? "error.main" : "#aaa",
                },
                "&.Mui-focused fieldset": {
                  borderColor: isOverRecommended ? "error.main" : "#fff",
                },
                "& input": {
                  textAlign: "center",
                  p: 0,
                },
              },
            }}
          />
          <Typography variant="body2" sx={{ color: "#aaa", ml: 0.5 }}>
            s max
          </Typography>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Typography variant="body2" sx={{ color: "#aaa" }}>
            FPS
          </Typography>
          <BufferedTextInput
            label=""
            value={selectionFpsOverride !== null ? String(selectionFpsOverride) : ""}
            placeholder={String(resolvedRecommendedFps ?? projectFps)}
            onCommit={handleFpsOverrideChange}
            sx={{
              width: 54,
              "& .MuiOutlinedInput-root": {
                height: 24,
                fontSize: "0.875rem",
                color: "#aaa",
                px: 0.5,
                "& fieldset": {
                  border: "none",
                  borderBottom: "1px dotted",
                  borderColor: "#666",
                  borderRadius: 0,
                },
                "&:hover fieldset": {
                  borderColor: "#aaa",
                },
                "&.Mui-focused fieldset": {
                  borderColor: "#fff",
                },
                "& input": {
                  textAlign: "center",
                  p: 0,
                },
              },
            }}
          />
          {resolvedRecommendedFps !== null && (
            <Typography variant="body2" sx={{ color: "#777" }}>
              (rec {resolvedRecommendedFps})
            </Typography>
          )}
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Typography variant="body2" sx={{ color: "#aaa" }}>
            Step
          </Typography>
          <BufferedTextInput
            label=""
            value={String(selectionFrameStep)}
            placeholder={
              resolvedRecommendedFrameStep !== null
                ? String(resolvedRecommendedFrameStep)
                : "1"
            }
            onCommit={handleFrameStepChange}
            sx={{
              width: 44,
              "& .MuiOutlinedInput-root": {
                height: 24,
                fontSize: "0.875rem",
                color: "#aaa",
                px: 0.5,
                "& fieldset": {
                  border: "none",
                  borderBottom: "1px dotted",
                  borderColor: "#666",
                  borderRadius: 0,
                },
                "&:hover fieldset": {
                  borderColor: "#aaa",
                },
                "&.Mui-focused fieldset": {
                  borderColor: "#fff",
                },
                "& input": {
                  textAlign: "center",
                  p: 0,
                },
              },
            }}
          />
          {resolvedRecommendedFrameStep !== null && (
            <Typography variant="body2" sx={{ color: "#777" }}>
              rec {resolvedRecommendedFrameStep}
            </Typography>
          )}
        </Box>

        <Button
          size="small"
          color="inherit"
          onClick={handleCancel}
          sx={{ color: "#aaa" }}
        >
          Cancel
        </Button>
        <Button size="small" variant="contained" onClick={handleConfirm}>
          Confirm Selection
        </Button>
      </Paper>
    </>
  );
}
