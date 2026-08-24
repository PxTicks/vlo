import { useCallback, useRef, useState, useEffect } from "react";
import {
  Box,
  Button,
  Collapse,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Typography,
} from "@mui/material";
import TuneIcon from "@mui/icons-material/Tune";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useProjectStore } from "../../project";
import {
  DEFAULT_PROJECT_OUTPUT_RESOLUTION,
  PROJECT_OUTPUT_RESOLUTIONS,
} from "../../project/outputResolutionOptions";
import { useTimelineStore } from "../useTimelineStore";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { BufferedTextInput } from "../../panelUI/components/BufferedTextInput";
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  RULER_HEIGHT,
  SNAP_THRESHOLD_PX,
} from "../constants";
import {
  ticksToPx as ticksToPxAt,
  pxToTicks as pxToTicksAt,
} from "../../../core/time/pixelGrid";
import {
  tickToMediaSeconds,
  mediaSecondsToTickExact,
} from "../../renderer/utils/mediaTime";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionRenderResolution,
  resolveSelectionFrameOffset,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
  snapSteppedRangeEdge,
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
  recommendedFrameOffset?: number | null;
}

const DEFAULT_TRACK_SELECTION_PROMPT =
  "Click timeline rows to choose which tracks to include in this selection.";

interface SelectionSettingProps {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
  /** Field width in px; the numbers here are short, so they stay narrow. */
  width: number;
  /** Trailing unit or recommendation shown after the field. */
  hint?: string;
  invalid?: boolean;
}

/** One labelled number field in the collapsed settings row. */
function SelectionSetting({
  label,
  value,
  placeholder,
  onCommit,
  width,
  hint,
  invalid = false,
}: SelectionSettingProps) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="body2" sx={{ color: "#aaa" }}>
        {label}
      </Typography>
      <BufferedTextInput
        label=""
        value={value}
        placeholder={placeholder}
        onCommit={onCommit}
        sx={{
          width,
          "& .MuiOutlinedInput-root": {
            height: 24,
            fontSize: "0.875rem",
            color: "#aaa",
            px: 0.5,
            "& fieldset": {
              border: "none",
              borderBottom: invalid ? "1px solid" : "1px dotted",
              borderColor: invalid ? "error.main" : "#666",
              borderRadius: 0,
            },
            "&:hover fieldset": {
              borderColor: invalid ? "error.main" : "#aaa",
            },
            "&.Mui-focused fieldset": {
              borderColor: invalid ? "error.main" : "#fff",
            },
            "& input": {
              textAlign: "center",
              p: 0,
            },
          },
        }}
      />
      {hint ? (
        <Typography variant="body2" sx={{ color: "#777" }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

const RESOLUTION_LABELS: Readonly<Record<number, string>> = {
  480: "480p",
  720: "720p",
  1080: "1080p",
  2160: "4K",
};

interface SelectionResolutionSettingProps {
  value: number | null;
  projectResolution: number;
  recommended: number | null;
  onChange: (resolution: number | null) => void;
}

/**
 * Short edge every render from this selection uses. Unlike its neighbours this
 * is a fixed set rather than a free number: an arbitrary short edge would be
 * accepted here and then rejected by the project resolution it falls back to.
 */
function SelectionResolutionSetting({
  value,
  projectResolution,
  recommended,
  onChange,
}: SelectionResolutionSettingProps) {
  const followsProject = value === null;
  const inherited = recommended ?? projectResolution;

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="body2" sx={{ color: "#aaa" }}>
        Res
      </Typography>
      <Select
        value={followsProject ? "" : String(value)}
        displayEmpty
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : Number(next));
        }}
        renderValue={(selected) =>
          selected === ""
            ? `Auto (${RESOLUTION_LABELS[inherited] ?? inherited})`
            : (RESOLUTION_LABELS[Number(selected)] ?? String(selected))
        }
        inputProps={{ "aria-label": "Selection render resolution" }}
        data-testid="selection-resolution-setting"
        sx={{
          minWidth: 96,
          height: 24,
          fontSize: "0.875rem",
          color: "#aaa",
          "& .MuiSelect-select": { py: 0, pl: 0.5 },
          "& fieldset": {
            border: "none",
            borderBottom: "1px dotted",
            borderColor: "#666",
            borderRadius: 0,
          },
          "&:hover fieldset": { borderColor: "#aaa" },
          "&.Mui-focused fieldset": { borderColor: "#fff" },
        }}
      >
        <MenuItem value="">
          {`Auto (${RESOLUTION_LABELS[inherited] ?? inherited})`}
        </MenuItem>
        {PROJECT_OUTPUT_RESOLUTIONS.map((option) => (
          <MenuItem key={option} value={String(option)}>
            {RESOLUTION_LABELS[option] ?? `${option}p`}
          </MenuItem>
        ))}
      </Select>
      {recommended !== null ? (
        <Typography variant="body2" sx={{ color: "#777" }}>
          {`rec ${RESOLUTION_LABELS[recommended] ?? recommended}`}
        </Typography>
      ) : null}
    </Box>
  );
}

export function SelectionOverlay({
  maxSelectionTicks = null,
  recommendedMaxTicks,
  recommendedFps,
  recommendedFrameStep,
  recommendedFrameOffset,
}: SelectionOverlayProps) {
  const selectionMode = useTimelineSelectionStore((s) => s.selectionMode);
  const selectionStage = useTimelineSelectionStore((s) => s.selectionStage);
  const startTick = useTimelineSelectionStore((s) => s.selectionStartTick);
  const endTick = useTimelineSelectionStore((s) => s.selectionEndTick);
  const updateSelectionEnd = useTimelineSelectionStore(
    (s) => s.updateSelectionEnd,
  );
  const selectionFpsOverride = useTimelineSelectionStore(
    (s) => s.selectionFpsOverride,
  );
  const selectionFrameStep = useTimelineSelectionStore(
    (s) => s.selectionFrameStep,
  );
  const selectionFrameOffset = useTimelineSelectionStore(
    (s) => s.selectionFrameOffset,
  );
  const selectionMessage = useTimelineSelectionStore((s) => s.selectionMessage);
  const selectionIncludeModeEnabled = useTimelineSelectionStore(
    (s) => s.selectionIncludeModeEnabled,
  );
  const selectionAllowIncludeAll = useTimelineSelectionStore(
    (s) => s.selectionAllowIncludeAll,
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
  const includeAllSelectionTracks = useTimelineSelectionStore(
    (s) => s.includeAllSelectionTracks,
  );
  const recommendedFpsFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedFps,
  );
  const recommendedFrameStepFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedFrameStep,
  );
  const recommendedFrameOffsetFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedFrameOffset,
  );
  const recommendedMaxTicksFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedMaxTicks,
  );
  const setSelectionFpsOverride = useTimelineSelectionStore(
    (s) => s.setSelectionFpsOverride,
  );
  const selectionResolutionOverride = useTimelineSelectionStore(
    (s) => s.selectionResolutionOverride,
  );
  const recommendedResolutionFromStore = useTimelineSelectionStore(
    (s) => s.selectionRecommendedResolution,
  );
  const setSelectionResolutionOverride = useTimelineSelectionStore(
    (s) => s.setSelectionResolutionOverride,
  );
  const setSelectionFrameStep = useTimelineSelectionStore(
    (s) => s.setSelectionFrameStep,
  );
  const setSelectionFrameOffset = useTimelineSelectionStore(
    (s) => s.setSelectionFrameOffset,
  );
  const onConfirmSelection = useExtractStore((s) => s.onConfirmSelection);
  const onCancelSelection = useExtractStore((s) => s.onCancelSelection);
  const zoomScale = useTimelineViewStore((s) => s.zoomScale);
  const scrollContainer = useTimelineViewStore((s) => s.scrollContainer);
  const projectFps = useProjectStore((s) => s.config.fps);
  const projectResolution = useProjectStore(
    (s) => s.config.outputResolution ?? DEFAULT_PROJECT_OUTPUT_RESOLUTION,
  );
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
  const effectiveFrameOffset = resolveSelectionFrameOffset({
    frameOffset: selectionFrameOffset,
  });
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const resolvedRecommendedFps =
    recommendedFps ?? recommendedFpsFromStore ?? null;
  const resolvedRecommendedFrameStep =
    recommendedFrameStep ?? recommendedFrameStepFromStore ?? null;
  const resolvedRecommendedFrameOffset =
    recommendedFrameOffset ?? recommendedFrameOffsetFromStore ?? null;
  const resolvedRecommendedMaxTicks =
    recommendedMaxTicks ?? recommendedMaxTicksFromStore ?? null;

  // `undefined` means follow external limits; `null` means explicitly unbounded.
  const [localMaxTicksOverride, setLocalMaxTicksOverride] = useState<
    number | null | undefined
  >(undefined);
  // The frame-rate and grid fields are workflow plumbing: most passes just drag
  // a range and confirm, so they stay behind a toggle.
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      effectiveFrameOffset,
    );
  }, [effectiveFrameOffset, effectiveFrameStep, localMaxTicks, ticksPerFrame]);

  const clampFrameCount = useCallback(
    (rawFrameCount: number, mode: "nearest" | "floor" | "ceil" = "floor") => {
      let frameCount = snapFrameCountToStep(
        rawFrameCount,
        effectiveFrameStep,
        mode,
        effectiveFrameOffset,
      );
      const maxFrameCount = getMaxFrameCount();
      if (maxFrameCount !== null) {
        frameCount = Math.min(frameCount, maxFrameCount);
      }
      return Math.max(1, frameCount);
    },
    [effectiveFrameOffset, effectiveFrameStep, getMaxFrameCount],
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
    (ticks: number) => ticksToPxAt(ticks, zoomScale),
    [zoomScale],
  );

  const pxToTicks = useCallback(
    (px: number) => pxToTicksAt(px, zoomScale),
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
      resolveTick: (edgeTick: number) => number | null,
    ): number | null => {
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
      if (
        snappedEdgeTick === null ||
        snappedEdgeTick < minTick ||
        snappedEdgeTick > maxTick
      ) {
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
        const rawStartTick = Math.max(
          0,
          dragOriginTickRef.current + deltaTicks,
        );
        const minStartTick = 0;
        const maxStartTick = Math.max(
          minStartTick,
          selectionEndTick - ticksPerFrame,
        );
        const resolveStartTick = (edgeTick: number) => {
          return snapSteppedRangeEdge({
            edge: "start",
            proposedTick: edgeTick,
            fixedTick: selectionEndTick,
            ticksPerFrame,
            frameStep: effectiveFrameStep,
            frameOffset: effectiveFrameOffset,
            mode: "floor",
            minTick: minStartTick,
            maxFrameCount: getMaxFrameCount(),
          });
        };
        const finalTick = maybeResolveSnappedEdgeTick(
          rawStartTick,
          minStartTick,
          maxStartTick,
          resolveStartTick,
        );

        if (finalTick !== null && finalTick < selectionEndTick) {
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
          return snapSteppedRangeEdge({
            edge: "end",
            proposedTick: edgeTick,
            fixedTick: selectionStartTick,
            ticksPerFrame,
            frameStep: effectiveFrameStep,
            frameOffset: effectiveFrameOffset,
            mode: "floor",
            maxTick: maxEndTick,
            maxFrameCount,
          });
        };
        const finalTick = maybeResolveSnappedEdgeTick(
          rawEndTick,
          minEndTick,
          maxEndTick,
          resolveEndTick,
        );

        if (finalTick !== null && finalTick > selectionStartTick) {
          updateSelectionEnd(finalTick);
          playbackClock.setTime(finalTick);
        }
      } else if (draggingRef.current === "middle") {
        useInteractionStore.getState().clearSnapPreview();
        const rawStartTick = Math.max(
          0,
          dragOriginTickRef.current + deltaTicks,
        );
        const snappedStartTick = snapTickToFrame(rawStartTick, ticksPerFrame);
        const durationFrameCount = clampFrameCount(
          (selectionEndTick - selectionStartTick) /
            Math.max(1e-6, ticksPerFrame),
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
      effectiveFrameOffset,
      effectiveFrameStep,
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
    onCancelSelection?.();
    useTimelineSelectionStore.getState().exitSelectionMode();
    const extractStore = useExtractStore.getState();
    extractStore.setOnConfirmSelection(null);
    extractStore.setOnCancelSelection(null);
  }, [onCancelSelection]);

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

  const currentDurationSeconds = tickToMediaSeconds(endTick - startTick);
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
  const trackSelectionPrompt = isTrackSelectionStage
    ? (selectionMessage ?? DEFAULT_TRACK_SELECTION_PROMPT)
    : null;
  const showRangeSelectionMessage =
    !!selectionMessage && !selectionIncludeModeEnabled;
  // The confirm row sits beside the duration readout until something taller
  // than a single line shares the paper.
  const stackPaperContents =
    isTrackSelectionStage || showRangeSelectionMessage || settingsOpen;
  const trackSelectionDialogTop = Math.max(
    8,
    (scrollContainer?.getBoundingClientRect().top ?? 0) + 8,
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
      const rawFrameCount = mediaSecondsToTickExact(val) / ticksPerFrame;
      const frameCount = snapFrameCountToStep(
        rawFrameCount,
        effectiveFrameStep,
        "floor",
        effectiveFrameOffset,
      );
      setLocalMaxTicksOverride(
        Math.max(ticksPerFrame, frameCount * ticksPerFrame),
      );
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

  const handleFrameOffsetChange = (valStr: string) => {
    const parsed = parseInt(valStr, 10);
    setSelectionFrameOffset(!isNaN(parsed) && parsed > 0 ? parsed : 1);
  };

  // What the collapsed row has to keep saying: the constraints a workflow put
  // on this selection are the reason a drag snaps the way it does.
  const effectiveResolution = resolveSelectionRenderResolution({
    override: selectionResolutionOverride,
    recommended: recommendedResolutionFromStore,
    project: projectResolution,
  });

  const settingsSummary = [
    `${effectiveFps} fps`,
    // Only when there is something to say: a workflow recommendation or a
    // user override. Matching the project is the unremarkable case.
    effectiveResolution !== projectResolution
      ? (RESOLUTION_LABELS[effectiveResolution] ?? `${effectiveResolution}p`)
      : null,
    effectiveFrameStep > 1 || effectiveFrameOffset > 1
      ? `step ${effectiveFrameStep}${
          effectiveFrameOffset > 1 ? `+${effectiveFrameOffset}` : ""
        }`
      : null,
    localMaxTicks !== null
      ? `max ${tickToMediaSeconds(localMaxTicks).toFixed(2)}s`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

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
          isTrackSelectionStage
            ? undefined
            : (e) => handlePointerDown("middle", e)
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
                      bgcolor: isIncluded
                        ? "#4fc3f7"
                        : "rgba(255, 255, 255, 0.2)",
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
          top: isTrackSelectionStage ? `${trackSelectionDialogTop}px` : "auto",
          bottom: isTrackSelectionStage ? "auto" : 16,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          bgcolor: "#222",
          border: "1px solid #444",
          px: 2,
          py: isTrackSelectionStage ? 0.75 : 1,
          display: "flex",
          flexDirection: stackPaperContents ? "column" : "row",
          gap: isTrackSelectionStage ? 0.75 : stackPaperContents ? 1 : 1.5,
          alignItems: stackPaperContents ? "stretch" : "center",
          borderRadius: 2,
          width: isTrackSelectionStage
            ? "auto"
            : showRangeSelectionMessage
              ? "min(90vw, 920px)"
              : "max-content",
          maxWidth: isTrackSelectionStage
            ? "min(88vw, 760px)"
            : "calc(100vw - 32px)",
        }}
      >
        {trackSelectionPrompt ? (
          <Typography
            variant="body2"
            title={trackSelectionPrompt}
            noWrap
            sx={{
              color: "#d7ecf6",
              lineHeight: 1.35,
              minWidth: 0,
            }}
          >
            {trackSelectionPrompt}
          </Typography>
        ) : null}

        {showRangeSelectionMessage ? (
          <Typography variant="body2" sx={{ color: "#ddd", lineHeight: 1.4 }}>
            {selectionMessage}
          </Typography>
        ) : null}

        {!isTrackSelectionStage ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 0.75,
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                gap: 1,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Typography variant="body2" sx={{ color: "#aaa" }}>
                Duration: {currentDurationSeconds.toFixed(2)}s (
                {currentFrameCount}f)
              </Typography>
              <Typography
                variant="body2"
                data-testid="selection-overlay-settings-summary"
                sx={{ color: "#777" }}
              >
                {settingsSummary}
              </Typography>
              <IconButton
                size="small"
                onClick={() => setSettingsOpen((open) => !open)}
                aria-expanded={settingsOpen}
                aria-label="Selection settings"
                data-testid="selection-overlay-settings-toggle"
                sx={{ color: settingsOpen ? "#fff" : "#888", p: 0.25 }}
              >
                <TuneIcon fontSize="small" />
              </IconButton>
            </Box>

            <Collapse in={settingsOpen} unmountOnExit>
              <Box
                data-testid="selection-overlay-settings"
                sx={{
                  display: "flex",
                  gap: 1.5,
                  alignItems: "center",
                  flexWrap: "wrap",
                  pt: 0.5,
                  borderTop: "1px solid #3a3a3a",
                }}
              >
                <SelectionSetting
                  label="Max"
                  value={
                    localMaxTicks !== null
                      ? tickToMediaSeconds(localMaxTicks).toFixed(2)
                      : ""
                  }
                  placeholder="∞"
                  onCommit={handleMaxLimitChange}
                  width={50}
                  hint="s"
                  invalid={isOverRecommended}
                />
                <SelectionSetting
                  label="FPS"
                  value={
                    selectionFpsOverride !== null
                      ? String(selectionFpsOverride)
                      : ""
                  }
                  placeholder={String(resolvedRecommendedFps ?? projectFps)}
                  onCommit={handleFpsOverrideChange}
                  width={54}
                  hint={
                    resolvedRecommendedFps !== null
                      ? `rec ${resolvedRecommendedFps}`
                      : undefined
                  }
                />
                <SelectionResolutionSetting
                  value={selectionResolutionOverride}
                  projectResolution={projectResolution}
                  recommended={recommendedResolutionFromStore}
                  onChange={setSelectionResolutionOverride}
                />
                <SelectionSetting
                  label="Step"
                  value={String(selectionFrameStep)}
                  placeholder={
                    resolvedRecommendedFrameStep !== null
                      ? String(resolvedRecommendedFrameStep)
                      : "1"
                  }
                  onCommit={handleFrameStepChange}
                  width={44}
                  hint={
                    resolvedRecommendedFrameStep !== null
                      ? `rec ${resolvedRecommendedFrameStep}`
                      : undefined
                  }
                />
                <SelectionSetting
                  label="Offset"
                  value={String(selectionFrameOffset)}
                  placeholder={
                    resolvedRecommendedFrameOffset !== null
                      ? String(resolvedRecommendedFrameOffset)
                      : "1"
                  }
                  onCommit={handleFrameOffsetChange}
                  width={44}
                  hint={
                    resolvedRecommendedFrameOffset !== null
                      ? `rec ${resolvedRecommendedFrameOffset}`
                      : undefined
                  }
                />
              </Box>
            </Collapse>
          </Box>
        ) : null}

        <Box
          data-testid="selection-overlay-actions"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            justifyContent: isTrackSelectionStage
              ? "space-between"
              : "flex-end",
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          {isTrackSelectionStage ? (
            <Typography
              variant="caption"
              sx={{ color: hasIncludedTracks ? "#7ec8e3" : "#ffb74d" }}
            >
              {trackScopeLabel}
            </Typography>
          ) : null}

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              marginLeft: isTrackSelectionStage ? "auto" : 0,
            }}
          >
            {isTrackSelectionStage ? (
              <>
                <Button
                  size="small"
                  color="inherit"
                  onClick={handleReturnToRangeSelection}
                  sx={{ color: "#aaa" }}
                >
                  Back to Range
                </Button>
                {selectionAllowIncludeAll ? (
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() =>
                      includeAllSelectionTracks(tracks.map((track) => track.id))
                    }
                    data-testid="selection-include-all"
                    sx={{ color: "#7ec8e3" }}
                  >
                    Include All
                  </Button>
                ) : null}
              </>
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
        </Box>
      </Paper>
    </>
  );
}
