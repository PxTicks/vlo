import { useCallback, useRef, useState, useEffect } from "react";
import { Box, Button, Paper, Typography } from "@mui/material";
import { useExtractStore } from "../../player/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useProjectStore } from "../../project";
import { useTimelineStore } from "../useTimelineStore";
import { playbackClock } from "../../player/services/PlaybackClock";
import { BufferedTextInput } from "../../panelUI/components/BufferedTextInput";
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  RULER_HEIGHT,
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  SNAP_THRESHOLD_PX,
} from "../constants";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
  snapTickToFrame,
} from "../../timelineSelection";
import { stopOverlayEventPropagation } from "../utils/stopOverlayEventPropagation";
import {
  buildTimelineSnapPoints,
  useInteractionStore,
} from "../hooks/useInteractionStore";
import { getEdgeSnapCandidate } from "../hooks/dnd/snapUtils";

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
  const selectionStage = useTimelineSelectionStore((s) => s.selectionStage);
  const startTick = useTimelineSelectionStore((s) => s.selectionStartTick);
  const endTick = useTimelineSelectionStore((s) => s.selectionEndTick);
  const updateSelectionEnd = useTimelineSelectionStore((s) => s.updateSelectionEnd);
  const selectionFpsOverride = useTimelineSelectionStore(
    (s) => s.selectionFpsOverride,
  );
  const selectionFrameStep = useTimelineSelectionStore((s) => s.selectionFrameStep);
  const selectionMessage = useTimelineSelectionStore((s) => s.selectionMessage);
  const selectionIncludeModeEnabled = useTimelineSelectionStore(
    (s) => s.selectionIncludeModeEnabled,
  );
  const selectionIncludedTrackIds = useTimelineSelectionStore(
    (s) => s.selectionIncludedTrackIds,
  );
  const enterTrackSelectionStage = useTimelineSelectionStore(
    (s) => s.enterTrackSelectionStage,
  );
  const returnToRangeSelectionStage = useTimelineSelectionStore(
    (s) => s.returnToRangeSelectionStage,
  );
  const toggleSelectionIncludedTrack = useTimelineSelectionStore(
    (s) => s.toggleSelectionIncludedTrack,
  );
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
  const tracks = useTimelineStore((s) => s.tracks);
  const snappingEnabled = useInteractionStore((s) => s.snappingEnabled);
  const interactionSnapTick = useInteractionStore((s) => s.snapTick);

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
  const snapPointsRef = useRef<number[]>([]);
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
      snapPointsRef.current =
        handle === "middle" ? [] : buildTimelineSnapPoints();
      useInteractionStore.getState().clearSnapPreview();

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

  const maybeResolveSnappedEdgeTick = useCallback(
    (
      rawEdgeTick: number,
      minTick: number,
      maxTick: number,
      resolveTick: (edgeTick: number) => number,
    ) => {
      const interaction = useInteractionStore.getState();
      const ticksToPxFromStore = useTimelineViewStore.getState().ticksToPx;

      if (!snappingEnabled || snapPointsRef.current.length === 0) {
        interaction.clearSnapPreview();
        return resolveTick(rawEdgeTick);
      }

      const rangeSnapPoints = snapPointsRef.current.filter(
        (tick) => tick >= minTick && tick <= maxTick,
      );
      const candidate = getEdgeSnapCandidate(
        rawEdgeTick,
        rangeSnapPoints,
        ticksToPxFromStore,
        SNAP_THRESHOLD_PX,
      );
      const hysteresisPx = SNAP_THRESHOLD_PX + 3;

      if (!candidate) {
        if (interaction.snapTick !== null) {
          const keepCurrent =
            Math.abs(ticksToPxFromStore(rawEdgeTick - interaction.snapTick)) <=
            hysteresisPx;
          if (keepCurrent) {
            return interaction.snapTick;
          }
        }
        interaction.clearSnapPreview();
        return resolveTick(rawEdgeTick);
      }

      const snappedEdgeTick = resolveTick(candidate.snapTick);
      if (snappedEdgeTick < minTick || snappedEdgeTick > maxTick) {
        if (interaction.snapTick !== null) {
          const keepCurrent =
            Math.abs(ticksToPxFromStore(rawEdgeTick - interaction.snapTick)) <=
            hysteresisPx;
          if (keepCurrent) {
            return interaction.snapTick;
          }
        }
        interaction.clearSnapPreview();
        return resolveTick(rawEdgeTick);
      }

      interaction.setSnapPreview({ tick: snappedEdgeTick });
      return snappedEdgeTick;
    },
    [snappingEnabled],
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
        const minStartTick = 0;
        const maxStartTick = Math.max(
          minStartTick,
          selectionEndTick - ticksPerFrame,
        );
        const resolveStartTick = (edgeTick: number) => {
          const boundedTick = Math.max(minStartTick, edgeTick);
          const rawFrameCount =
            (selectionEndTick - boundedTick) / Math.max(1e-6, ticksPerFrame);
          const frameCount = clampFrameCount(rawFrameCount, "floor");
          return Math.max(
            minStartTick,
            selectionEndTick - frameCount * ticksPerFrame,
          );
        };
        const finalTick = maybeResolveSnappedEdgeTick(
          rawStartTick,
          minStartTick,
          maxStartTick,
          resolveStartTick,
        );

        if (finalTick < selectionEndTick) {
          updateSelectionStart(finalTick);
          playbackClock.setTime(finalTick);
        }
      } else if (draggingRef.current === "end") {
        const rawEndTick = dragOriginTickRef.current + deltaTicks;
        const minEndTick = selectionStartTick + ticksPerFrame;
        const maxFrameCount = getMaxFrameCount();
        const maxEndTick =
          maxFrameCount === null
            ? Number.POSITIVE_INFINITY
            : selectionStartTick + maxFrameCount * ticksPerFrame;
        const resolveEndTick = (edgeTick: number) => {
          const rawFrameCount =
            (edgeTick - selectionStartTick) / Math.max(1e-6, ticksPerFrame);
          const frameCount = clampFrameCount(rawFrameCount, "floor");
          return selectionStartTick + frameCount * ticksPerFrame;
        };
        const finalTick = maybeResolveSnappedEdgeTick(
          rawEndTick,
          minEndTick,
          maxEndTick,
          resolveEndTick,
        );

        if (finalTick > selectionStartTick) {
          updateSelectionEnd(finalTick);
          playbackClock.setTime(finalTick);
        }
      } else if (draggingRef.current === "middle") {
        useInteractionStore.getState().clearSnapPreview();
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
    [
      clampFrameCount,
      getMaxFrameCount,
      maybeResolveSnappedEdgeTick,
      pxToTicks,
      ticksPerFrame,
    ],
  );

  const handlePointerUp = useCallback(() => {
    draggingRef.current = null;
    snapPointsRef.current = [];
    useInteractionStore.getState().clearSnapPreview();
    setDraggingHandle(null);
  }, []);

  useEffect(() => {
    return () => {
      useInteractionStore.getState().clearSnapPreview();
    };
  }, []);

  const handleCancel = useCallback(() => {
    useInteractionStore.getState().clearSnapPreview();
    useTimelineSelectionStore.getState().exitSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectionIncludeModeEnabled && selectionStage === "range") {
      enterTrackSelectionStage();
      return;
    }

    if (onConfirmSelection) onConfirmSelection();
  }, [
    enterTrackSelectionStage,
    onConfirmSelection,
    selectionIncludeModeEnabled,
    selectionStage,
  ]);

  const handleReturnToRangeSelection = useCallback(() => {
    returnToRangeSelectionStage();
  }, [returnToRangeSelectionStage]);

  if (!selectionMode) return null;

  const startPx = ticksToPx(startTick);
  const endPx = ticksToPx(endTick);
  const snapIndicatorLeft =
    interactionSnapTick === null
      ? null
      : TRACK_HEADER_WIDTH + ticksToPx(interactionSnapTick);

  const currentDurationSeconds = (endTick - startTick) / TICKS_PER_SECOND;
  const currentFrameCount = Math.max(
    1,
    Math.round((endTick - startTick) / Math.max(1e-6, ticksPerFrame)),
  );
  const isTrackSelectionStage =
    selectionIncludeModeEnabled && selectionStage === "tracks";
  const hasIncludedTracks = selectionIncludedTrackIds.length > 0;
  const trackScopeLabel = hasIncludedTracks
    ? `${selectionIncludedTrackIds.length} included track${
        selectionIncludedTrackIds.length === 1 ? "" : "s"
      }`
    : "No tracks selected";
  const showSelectionMessage =
    !!selectionMessage &&
    (!selectionIncludeModeEnabled || isTrackSelectionStage);
  const showRangeSelectionMeta = showSelectionMessage;

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

      <Box
        data-testid="selection-snap-indicator"
        sx={{
          position: "absolute",
          top: `${RULER_HEIGHT}px`,
          bottom: 0,
          left: snapIndicatorLeft !== null ? `${snapIndicatorLeft}px` : 0,
          width: "2px",
          bgcolor: "#fbc02d",
          boxShadow:
            "0 0 0 1px rgba(251, 192, 45, 0.45), 0 0 8px rgba(251, 192, 45, 0.45)",
          zIndex: 40,
          pointerEvents: "none",
          display: snapIndicatorLeft !== null ? "block" : "none",
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
          zIndex: isTrackSelectionStage ? 55 : 25,
          cursor: isTrackSelectionStage
            ? "default"
            : draggingHandle === "middle"
              ? "grabbing"
              : "grab",
          pointerEvents: isTrackSelectionStage ? "none" : "auto",
        }}
        onPointerDown={
          isTrackSelectionStage ? undefined : (e) => handlePointerDown("middle", e)
        }
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {!isTrackSelectionStage ? (
        <>
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
        </>
      ) : null}

      {isTrackSelectionStage
        ? tracks.map((track, index) => {
            const isIncluded = selectionIncludedTrackIds.includes(track.id);

            return (
              <Box
                key={track.id}
                component="button"
                type="button"
                data-testid={`selection-track-row-${track.id}`}
                aria-pressed={isIncluded}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelectionIncludedTrack(track.id);
                }}
                onMouseDown={stopOverlayEventPropagation}
                onPointerDown={stopOverlayEventPropagation}
                sx={{
                  position: "absolute",
                  top: `${RULER_HEIGHT + index * TRACK_HEIGHT}px`,
                  left: 0,
                  right: 0,
                  height: `${TRACK_HEIGHT}px`,
                  zIndex: 45,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  px: 1.5,
                  border: "none",
                  borderRadius: 0,
                  bgcolor: isIncluded
                    ? "rgba(79, 195, 247, 0.12)"
                    : "rgba(0, 0, 0, 0.58)",
                  boxShadow: isIncluded
                    ? "inset 0 0 0 1px rgba(79, 195, 247, 0.55), inset 0 0 24px rgba(79, 195, 247, 0.14)"
                    : "inset 0 -1px 0 rgba(255, 255, 255, 0.04)",
                  color: isIncluded ? "#ecf8fd" : "#a7b6bf",
                  cursor: "pointer",
                  transition:
                    "background-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease",
                  "&:hover": {
                    bgcolor: isIncluded
                      ? "rgba(79, 195, 247, 0.16)"
                      : "rgba(9, 15, 18, 0.68)",
                  },
                  "&:focus-visible": {
                    outline: "2px solid rgba(129, 212, 250, 0.95)",
                    outlineOffset: "-2px",
                  },
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minWidth: 0,
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "999px",
                      bgcolor: isIncluded ? "#4fc3f7" : "rgba(255, 255, 255, 0.2)",
                      flexShrink: 0,
                    }}
                  />
                  <Typography variant="body2" noWrap>
                    {track.label}
                  </Typography>
                </Box>

                <Typography
                  variant="caption"
                  sx={{
                    color: isIncluded ? "#d8f4ff" : "#8fa2ad",
                    letterSpacing: 0.2,
                    textTransform: "uppercase",
                    flexShrink: 0,
                  }}
                >
                  {isIncluded ? "Included" : "Click to include"}
                </Typography>
              </Box>
            );
          })
        : null}

      <Paper
        data-testid="selection-overlay-paper"
        onClick={stopOverlayEventPropagation}
        onMouseDown={stopOverlayEventPropagation}
        onPointerDown={stopOverlayEventPropagation}
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
          flexDirection:
            isTrackSelectionStage || showRangeSelectionMeta ? "column" : "row",
          gap: isTrackSelectionStage || showRangeSelectionMeta ? 1 : 1.5,
          alignItems:
            isTrackSelectionStage || showRangeSelectionMeta
              ? "stretch"
              : "center",
          borderRadius: 2,
          width:
            isTrackSelectionStage || showRangeSelectionMeta
              ? "min(90vw, 920px)"
              : "max-content",
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        {showSelectionMessage ? (
          <Typography variant="body2" sx={{ color: "#ddd", lineHeight: 1.4 }}>
            {selectionMessage}
          </Typography>
        ) : null}

        {isTrackSelectionStage ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 1,
              flexWrap: "wrap",
            }}
          >
            <Typography variant="body2" sx={{ color: "#d7ecf6", lineHeight: 1.5 }}>
              Click timeline rows to choose which tracks to include in this
              selection.
            </Typography>
            <Typography
              variant="caption"
              sx={{ color: hasIncludedTracks ? "#7ec8e3" : "#ffb74d" }}
            >
              {trackScopeLabel}
            </Typography>
          </Box>
        ) : null}

        {isTrackSelectionStage ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 1,
              flexWrap: "wrap",
            }}
          >
            <Typography variant="body2" sx={{ color: "#aaa" }}>
              Duration: {currentDurationSeconds.toFixed(2)}s ({currentFrameCount}f)
            </Typography>
            {!hasIncludedTracks ? (
              <Typography variant="caption" sx={{ color: "#ffb74d" }}>
                Select at least one track to continue.
              </Typography>
            ) : null}
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              gap: 1.5,
              alignItems: "center",
              flexWrap: showRangeSelectionMeta ? "wrap" : "nowrap",
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
                value={
                  selectionFpsOverride !== null ? String(selectionFpsOverride) : ""
                }
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
          </Box>
        )}

        <Box
          data-testid="selection-overlay-actions"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            justifyContent: "flex-end",
            flexShrink: 0,
          }}
        >
          {isTrackSelectionStage ? (
            <Button
              size="small"
              color="inherit"
              onClick={handleReturnToRangeSelection}
              sx={{ color: "#aaa" }}
            >
              Back to Range
            </Button>
          ) : null}
          <Button
            size="small"
            color="inherit"
            onClick={handleCancel}
            sx={{ color: "#aaa" }}
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={handleConfirm}
            disabled={isTrackSelectionStage && !hasIncludedTracks}
          >
            {isTrackSelectionStage ? "Confirm Tracks" : "Confirm Selection"}
          </Button>
        </Box>
      </Paper>
    </>
  );
}
