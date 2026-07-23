import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import { Box, Paper, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import MusicOffIcon from "@mui/icons-material/MusicOff";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import FastRewindIcon from "@mui/icons-material/FastRewind";

import { styled } from "@mui/material/styles";
import { CLIP_HEIGHT, TRACK_HEIGHT, RULER_HEIGHT } from "../constants";
import { timelineSpanStyleX } from "../utils/timelineGeometry";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import type {
  AssetBackedBaseClip,
  AssetBackedTimelineClip,
  BaseClip,
  StandardTimelineClip,
  TimelineClip as TimelineClipType,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip, isCompositeClip } from "../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../types/Components";
import type { Asset } from "../../../types/Asset";
import { isBeatMarker } from "../../../types/Components";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { toExtensionClipSnapshot } from "../api";
import { AppMenu } from "../../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";
import { useAsset } from "../../userAssets/api";
import { useTimelineStore } from "../useTimelineStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { useSamAudioExtractDialogStore } from "../../samAudio";
import { reverseTimelineClip } from "../utils/reverseClip";
import { ThumbnailCanvas } from "./ThumbnailCanvas";
import { TimelineClipOverlayLayer } from "./TimelineClipOverlayLayer";
import type { TimelineClipPresentation } from "../utils/clipPresentation";
import { extensionEntityProviderRegistry } from "../../extensions/entities/publicApi";
import { useCompositeTimelineStore } from "../../composite/useCompositeTimelineStore";
import { useCompositeLibraryStore } from "../../composite/useCompositeLibraryStore";
import { useAssetStore } from "../../userAssets";
import { useProjectStore } from "../../project/useProjectStore";
import { getProjectDimensions } from "../../renderer/utils/dimensions";
import { resolveTimelineThumbnailClip } from "../utils/resolveTimelineThumbnailClip";

const EMPTY_ASSETS: readonly Asset[] = [];

// --- Sub-component for Handles ---
interface HandleProps {
  id: string;
  clip: TimelineClipType;
  side: "left" | "right";
}

const ResizeHandle = ({ id, clip, side }: HandleProps) => {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id,
    data: { clip, type: "resize", side },
  });

  return (
    <Box
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-testid={`timeline-clip-resize-handle-${side}`}
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: "12px",
        cursor: "ew-resize",
        zIndex: 20,
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: side === "right" ? "6px" : undefined,
          right: side === "left" ? "6px" : undefined,
          width: "6px",
          bgcolor: "rgba(255,255,255,0.5)",
        },
        "&:hover::after": { bgcolor: "white" },
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
};

// --- Styled Components ---

const ClipRoot = styled(Paper)(({ theme }) => ({
  position: "absolute",
  height: CLIP_HEIGHT,
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  overflow: "hidden",
  userSelect: "none",
  paddingLeft: theme.spacing(1),
  borderRadius: "4px",
  pointerEvents: "auto",
}));

// --- Main Component ---
interface TimelineClipProps {
  clip: BaseClip | TimelineClipType;
  isOverlay?: boolean;
  clipOverlays?: readonly TimelineClipOverlayDefinition[];
  presentation?: TimelineClipPresentation;
}

function TimelineClipComponent({
  clip,
  isOverlay = false,
  clipOverlays = [],
  presentation,
}: TimelineClipProps) {
  const entityProviderRevision = useSyncExternalStore(
    (listener) => extensionEntityProviderRegistry.subscribe(listener),
    () => extensionEntityProviderRegistry.getRevision(),
    () => extensionEntityProviderRegistry.getRevision(),
  );
  const domRef = useRef<HTMLElement | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isReversingClip, setIsReversingClip] = useState(false);

  const startTime =
    presentation?.start ??
    ("start" in clip ? (clip as TimelineClipType).start : 0);
  const displayDuration = presentation?.duration ?? clip.timelineDuration;
  const timelineClip = "start" in clip ? (clip as TimelineClipType) : null;
  const compositeId = isCompositeClip(timelineClip)
    ? timelineClip.compositeId
    : null;
  const compositeAsset = useCompositeLibraryStore((state) =>
    compositeId
      ? state.composites.find((candidate) => candidate.id === compositeId)
      : undefined,
  );
  const assets = useAssetStore((state) =>
    compositeId ? state.assets : EMPTY_ASSETS,
  );
  const projectFps = useProjectStore((state) =>
    compositeId ? state.config.fps : 0,
  );
  const projectAspectRatio = useProjectStore(
    (state) => compositeId ? state.config.aspectRatio : "16:9",
  );
  const showCompositeLabel = isCompositeClip(timelineClip) && !isOverlay;
  // Detached subject for extension context-menu commands. Non-overlay clips
  // (the only ones whose menu can open) always narrow to a full TimelineClip.
  const clipMenuContext = useMemo<HostMenuSubject<"timeline.clip.context">>(
    () => ({
      slot: "timeline.clip.context",
      clip:
        timelineClip !== null
          ? toExtensionClipSnapshot(timelineClip)
          : Object.freeze({
              id: clip.id,
              type: clip.type,
              name: clip.name,
              trackId: "trackId" in clip ? clip.trackId : "",
              startTicks: startTime,
              durationTicks: clip.timelineDuration,
              transformations: [],
            }),
    }),
    [clip, timelineClip, startTime],
  );
  const extensionProviderId =
    clip.type === "extension"
      ? `${clip.extensionPayload.extensionId}/${clip.extensionPayload.typeId}`
      : null;
  const extensionProviderAvailability =
    clip.type === "extension"
      ? extensionEntityProviderRegistry.getAvailability(clip.extensionPayload)
      : null;
  void entityProviderRevision;
  const extensionPresentation =
    clip.type === "extension"
      ? extensionEntityProviderRegistry.getTimelinePresentation(
          clip.extensionPayload,
        )
      : null;
  const extensionPlaceholderLabel =
    extensionProviderAvailability === "missing"
      ? "Missing"
      : extensionProviderAvailability === "incompatible"
        ? "Incompatible"
        : extensionProviderAvailability === "renderer_unavailable"
          ? "No renderer"
          : extensionProviderAvailability === "available"
            ? extensionPresentation?.label ?? "Extension"
          : null;
  // Composite placements retain an asset-backed shape, while thumbnail frame
  // planning resolves canonical live/baked source policy.
  const thumbnailClip: AssetBackedBaseClip | AssetBackedTimelineClip | null =
    useMemo(() => {
      if (!isAssetBackedClip(clip)) {
        return null;
      }
      return resolveTimelineThumbnailClip({
        clip,
        composite: compositeAsset,
        assets,
        logicalDimensions: getProjectDimensions(projectAspectRatio),
        projectFps,
      });
    }, [
      assets,
      clip,
      compositeAsset,
      projectAspectRatio,
      projectFps,
    ]);
  const isClipMuted =
    timelineClip !== null && timelineClip.type !== "mask"
      ? timelineClip.isMuted === true
      : false;
  const canMute =
    timelineClip !== null &&
    timelineClip.type !== "mask";

  // --- SELECTORS ---
  const isSelected = useTimelineStore((state) =>
    state.selectedClipIds.includes(clip.id),
  );

  const isActive = useInteractionStore(
    (state) => state.activeId !== null && state.activeId.includes(clip.id),
  );

  const operation = useInteractionStore((state) => state.operation);
  const isInternalMove = useInteractionStore(
    (state) =>
      state.operation === "move" &&
      state.activeClip !== null &&
      "trackId" in state.activeClip,
  );
  const transformDropPreview = useInteractionStore((state) =>
    state.transformDropPreview?.kind === "clip" &&
    state.transformDropPreview.clipId === clip.id
      ? state.transformDropPreview
      : null,
  );

  // 1. Get Track Index
  const trackId = "trackId" in clip ? (clip as TimelineClipType).trackId : "";
  const tracks = useTimelineStore((state) => state.tracks);
  const trackIndex = tracks.findIndex((t) => t.id === trackId);
  const track = tracks[trackIndex];
  const isTrackVisible = track?.isVisible ?? true;
  const clipAsset = useAsset(
    isAssetBackedClip(timelineClip) ? timelineClip.assetId : undefined,
  );
  const canExtractAudio =
    timelineClip !== null &&
    track !== undefined &&
    timelineClip.type === "video" &&
    clipAsset?.hasAudio !== false;
  const canReverseClip =
    timelineClip !== null &&
    (timelineClip.type === "video" || timelineClip.type === "audio") &&
    typeof timelineClip.sourceDuration === "number" &&
    Number.isFinite(timelineClip.sourceDuration) &&
    timelineClip.sourceDuration > 0;

  const beatMarkersComponent = useTimelineStore((state) => {
    const liveClip = state.clips.find((candidate) => candidate.id === clip.id);
    if (!liveClip || liveClip.type === "mask") return null;
    const markers = (liveClip.components ?? []).find(
      (component): component is MarkersComponent =>
        component.type === "markers",
    );
    if (!markers) return null;
    return markers.parameters.markers.some(isBeatMarker) ? markers : null;
  });
  const canRemoveBeats = beatMarkersComponent !== null;

  // 2. Vertical Position
  const topPos = isOverlay ? 0 : trackIndex * TRACK_HEIGHT + RULER_HEIGHT + 5;

  // 3. Base Geometry Calculations — scaled via `--timeline-zoom` in CSS, with
  // live resize/move deltas folded into the same calc.
  const spanStyle = timelineSpanStyleX(startTime, displayDuration, {
    headerOffset: true,
    extraLeft: "var(--drag-delta-x, 0px)",
    extraWidth: "var(--drag-delta-w, 0px)",
  });

  const { attributes, listeners, setNodeRef, isDragging, transform } =
    useDraggable({
      id: clip.id,
      data: { clip, type: "clip" },
      disabled: isOverlay,
    });

  // 4. Transient Updates (Resizing & Moving)
  useEffect(() => {
    // We need to listen if:
    // 1. We are the Active Item (Leader or Resizing)
    // 2. OR We are Selected and another timeline clip is moving (Follower).
    // External asset drags also use the "move" operation, but must never pull
    // the current timeline selection along with their preview.
    const shouldSubscribe = isActive || (isSelected && isInternalMove);

    if (isOverlay || !shouldSubscribe) return;

    // Define the update logic as a reusable function
    const updateStyle = (
      state: ReturnType<typeof useInteractionStore.getState>,
    ) => {
      const element = domRef.current;
      if (!element) return;

      const { currentDeltaX, currentDeltaY, constraints } = state;

      // A. RESIZE
      if (
        state.activeId === `resize_left_${clip.id}` ||
        state.activeId === `resize_right_${clip.id}`
      ) {
        const activeDeltaX = currentDeltaX;

        const getClampedDelta = (d: number) => {
          if (!constraints) return d;
          return Math.max(constraints.minPx, Math.min(d, constraints.maxPx));
        };
        const clampedDelta = getClampedDelta(activeDeltaX);

        if (state.activeId === `resize_right_${clip.id}`) {
          element.style.setProperty("--drag-delta-w", `${clampedDelta}px`);
          element.style.setProperty("--drag-delta-x", "0px");
        } else if (state.activeId === `resize_left_${clip.id}`) {
          element.style.setProperty("--drag-delta-x", `${clampedDelta}px`);
          element.style.setProperty("--drag-delta-w", `${-clampedDelta}px`);
        }
      }

      // B. MOVE (Follower Logic)
      // If we are part of the selection but NOT the leader (no transform from dnd-kit),
      // we must manually mirror the drag deltas.
      else if (
        state.operation === "move" &&
        state.activeClip !== null &&
        "trackId" in state.activeClip &&
        isSelected &&
        !transform
      ) {
        element.style.transform = `translate3d(${currentDeltaX}px, ${currentDeltaY}px, 0)`;
      }
    };

    // 1. Initial Sync
    updateStyle(useInteractionStore.getState());

    // 2. Subscribe
    const unsubscribe = useInteractionStore.subscribe(updateStyle);

    return () => {
      unsubscribe();
      if (domRef.current) {
        const element = domRef.current;
        const op = useInteractionStore.getState().operation;

        if (!op) {
          // Only delay on drag complete to prevent drop flicker
          requestAnimationFrame(() => {
            element.style.removeProperty("--drag-delta-x");
            element.style.removeProperty("--drag-delta-w");
          });
        } else {
          // Synchronous clear during drag to prevent RAF buildup lag
          element.style.removeProperty("--drag-delta-x");
          element.style.removeProperty("--drag-delta-w");
        }

        // Clean up manual transform if we applied it
        if (!transform) element.style.transform = "";
      }
    };
  }, [
    isActive,
    isInternalMove,
    operation,
    clip.id,
    isOverlay,
    isSelected,
    transform,
  ]);

  const getBackgroundColor = () => {
    // Composite placements are video clips; keep their distinct colour.
    if (isCompositeClip(clip)) {
      return "#7c3aed";
    }
    switch (clip.type) {
      case "video":
        return "#2563eb";
      case "image":
        return "#0ea5e9";
      case "text":
        return "#f59e0b";
      case "shape":
        return "#10b981";
      case "extension":
        return extensionProviderAvailability === "available"
          ? (extensionPresentation?.color ?? "#1e3a8a")
          : extensionProviderAvailability === "incompatible"
            ? "#991b1b"
            : "#7c2d12";
      case "audio":
        return "#16a34a";
      case "adjustment":
        return "#5fa8ff";
      default:
        return "#4b5563";
    }
  };

  const ghostOpacity = 1; // Always visible now.
  const transformDropOutline =
    transformDropPreview === null
      ? null
      : transformDropPreview.compatible
        ? "#4dabf5"
        : "#f44336";

  const setRefs = (node: HTMLElement | null) => {
    setNodeRef(node);
    domRef.current = node;
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isOverlay) return;
    e.preventDefault();
    e.stopPropagation();
    const store = useTimelineStore.getState();
    if (!store.selectedClipIds.includes(clip.id)) {
      store.selectClip(clip.id);
    }
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => setContextMenuPos(null);

  const handleContextRemoveBeats = () => {
    if (!beatMarkersComponent) {
      closeContextMenu();
      return;
    }
    const remaining = beatMarkersComponent.parameters.markers.filter(
      (marker) => !isBeatMarker(marker),
    );
    const store = useTimelineStore.getState();
    if (remaining.length === 0) {
      store.removeClipComponent(clip.id, beatMarkersComponent.id);
    } else {
      store.updateClipComponent(
        clip.id,
        beatMarkersComponent.id,
        (component) => {
          if (component.type !== "markers") return component;
          return {
            ...component,
            parameters: { ...component.parameters, markers: remaining },
          };
        },
      );
    }
    closeContextMenu();
  };

  const handleReverseClip = async () => {
    if (!timelineClip || !canReverseClip) {
      closeContextMenu();
      return;
    }
    closeContextMenu();
    setIsReversingClip(true);
    try {
      await reverseTimelineClip(timelineClip.id);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Failed to reverse the clip.",
      );
    } finally {
      setIsReversingClip(false);
    }
  };

  const handleExtractAudio = () => {
    if (
      timelineClip === null ||
      timelineClip.type !== "video"
    ) {
      closeContextMenu();
      return;
    }

    closeContextMenu();
    useSamAudioExtractDialogStore.getState().openForClip(timelineClip.id);
  };

  const handleOpenComposite = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!timelineClip || !isCompositeClip(timelineClip)) return;
    useCompositeTimelineStore.getState().openCompositeClip(timelineClip.id);
  };

  // Menu as data: store-level actions dispatch through the host command
  // table; handlers still coupled to component state remain inline actions.
  const clipMenuItems: HostMenuItemDescriptor[] = [
    {
      kind: "command",
      id: "delete",
      command: "timeline.clip.delete",
      subject: { clipId: clip.id },
      label: "Delete",
      icon: <DeleteOutlineIcon fontSize="small" />,
      group: "1_clip",
    },
    {
      kind: "command",
      id: "copy",
      command: "timeline.clip.copy",
      subject: { clipId: clip.id },
      label: "Copy",
      icon: <ContentCopyIcon fontSize="small" />,
      group: "1_clip",
    },
    ...(canExtractAudio
      ? [
          {
            kind: "action",
            id: "extract-audio",
            label: "Extract Audio",
            icon: <GraphicEqIcon fontSize="small" />,
            group: "1_clip",
            run: handleExtractAudio,
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    ...(canReverseClip
      ? [
          {
            kind: "action",
            id: "reverse",
            label: isReversingClip ? "Reversing..." : "Reverse Clip",
            icon: <FastRewindIcon fontSize="small" />,
            group: "1_clip",
            disabled: isReversingClip,
            run: () => void handleReverseClip(),
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    ...(canMute
      ? [
          {
            kind: "command",
            id: "toggle-mute",
            command: "timeline.clip.toggle-mute",
            subject: { clipId: clip.id },
            label: isClipMuted ? "Unmute" : "Mute",
            icon: isClipMuted ? (
              <VolumeUpIcon fontSize="small" />
            ) : (
              <VolumeOffIcon fontSize="small" />
            ),
            group: "1_clip",
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    ...(canRemoveBeats
      ? [
          {
            kind: "action",
            id: "remove-beats",
            label: "Remove Beats",
            icon: <MusicOffIcon fontSize="small" />,
            group: "1_clip",
            run: handleContextRemoveBeats,
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
  ];

  return (
    <ClipRoot
      ref={setRefs}
      {...listeners}
      {...attributes}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={handleContextMenu}
      onClick={(e) => {
        e.stopPropagation();
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        useTimelineStore.getState().selectClip(clip.id, isMulti);
      }}
      elevation={2}
      style={
        {
          // --- Dynamic Visuals (Hybrid approach) ---
          backgroundColor: getBackgroundColor(),
          cursor: "default",
          border: "1px solid rgba(255,255,255,0.2)",
          outline: transformDropOutline
            ? `2px solid ${transformDropOutline}`
            : isSelected
              ? "2px solid #fff"
              : "2px solid transparent",
          outlineOffset: "-1px",
          opacity: isOverlay
            ? 1
            : isTrackVisible
              ? ghostOpacity
              : ghostOpacity * 0.3,
          zIndex: isDragging ? 38 : isOverlay ? 999 : isSelected ? 10 : 1,
          boxShadow: transformDropOutline
            ? `0 0 0 2px ${transformDropOutline}55`
            : isDragging
              ? "0 4px 8px rgba(0,0,0,0.5)"
              : "none",
          transition: isActive ? "none" : "box-shadow 0.2s, outline-color 0.1s",

          // --- Metrics & Positioning ---
          left: isOverlay ? "0px" : spanStyle.left,
          width: spanStyle.width,
          top: topPos,
          // Apply transform directly from hook if available (priority) or handled by effect
          transform: transform
            ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
            : undefined,
        } as React.CSSProperties
      }
      data-testid="timeline-clip"
      data-clip-id={clip.id}
      data-selected={isSelected ? "true" : "false"}
      data-transform-drop-target={
        transformDropPreview
          ? transformDropPreview.compatible
            ? "compatible"
            : "incompatible"
          : undefined
      }
      data-track-visible={isTrackVisible ? "true" : "false"}
      data-extension-provider={
        extensionProviderAvailability ?? undefined
      }
      data-extension-renderer={
        extensionProviderId
          ? extensionProviderAvailability === "available"
            ? "available"
            : "unavailable"
          : undefined
      }
    >
      {showCompositeLabel || extensionProviderId ? (
        <Box
          component={showCompositeLabel ? "button" : "div"}
          type={showCompositeLabel ? "button" : undefined}
          data-testid={
            extensionProviderAvailability === "missing"
              ? "timeline-clip-missing-extension-label"
              : extensionProviderId
                ? "timeline-clip-extension-label"
                : "timeline-clip-composite-open"
          }
          aria-label={showCompositeLabel ? "Open composite editor" : undefined}
          onPointerDown={
            showCompositeLabel
              ? (event: React.PointerEvent<HTMLElement>) =>
                  event.stopPropagation()
              : undefined
          }
          onMouseDown={
            showCompositeLabel
              ? (event: React.MouseEvent<HTMLElement>) =>
                  event.stopPropagation()
              : undefined
          }
          onClick={showCompositeLabel ? handleOpenComposite : undefined}
          sx={{
            position: "absolute",
            top: 3,
            left: 4,
            zIndex: 18,
            height: 18,
            maxWidth: "calc(100% - 8px)",
            px: 0.75,
            borderRadius: "3px",
            border: "1px solid rgba(255,255,255,0.35)",
            bgcolor: "rgba(0,0,0,0.38)",
            color: "#fff",
            fontSize: "0.58rem",
            fontWeight: 700,
            lineHeight: 1,
            textTransform: "uppercase",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            m: 0,
            appearance: "none",
            fontFamily: "inherit",
            pointerEvents: showCompositeLabel ? "auto" : "none",
            cursor: showCompositeLabel ? "pointer" : "default",
          }}
        >
          {extensionProviderId
            ? `${extensionPlaceholderLabel} · ${extensionProviderId}`
            : "Composite"}
        </Box>
      ) : null}
      {thumbnailClip ? (
        <ThumbnailCanvas
          clip={thumbnailClip}
          isDragging={isDragging}
          presentationStart={presentation?.start}
          presentationDuration={presentation?.duration}
          mapPresentationOffsetToClipOffset={
            presentation?.mapPresentationOffsetToClipOffset
          }
        />
      ) : null}
      {!isDragging && !isOverlay && timelineClip ? (
        <TimelineClipOverlayLayer
          clip={timelineClip}
          isSelected={isSelected}
          clipOverlays={clipOverlays}
          presentation={presentation}
        />
      ) : null}
      {isSelected && !isDragging && !isOverlay && (
        <>
          <ResizeHandle
            id={`resize_left_${clip.id}`}
            clip={clip as StandardTimelineClip}
            side="left"
          />
          <ResizeHandle
            id={`resize_right_${clip.id}`}
            clip={clip as StandardTimelineClip}
            side="right"
          />
        </>
      )}

      <Typography
        variant="caption"
        noWrap
        sx={{
          fontWeight: "bold",
          pointerEvents: "none",
          mt: showCompositeLabel || extensionProviderId ? 2.25 : 0,
        }}
      >
        {clip.name}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontSize: "0.6rem", opacity: 0.8, pointerEvents: "none" }}
      >
        {tickToMediaSeconds(displayDuration).toFixed(2)}s
      </Typography>
      <AppMenu
        menuId="timeline.clip.context"
        subject={clipMenuContext}
        items={clipMenuItems}
        open={contextMenuPos !== null}
        onClose={closeContextMenu}
        anchorPosition={
          contextMenuPos
            ? { top: contextMenuPos.y, left: contextMenuPos.x }
            : undefined
        }
        onContextMenu={(e) => e.preventDefault()}
        // Menu clicks bubble through the portal to ClipRoot's onClick and
        // would re-select a clip the command just deleted.
        onClick={(e) => e.stopPropagation()}
        extensionItemTestIdPrefix="extension-clip-menu-item-"
      />
    </ClipRoot>
  );
}

export const TimelineClipItem = memo(TimelineClipComponent);
