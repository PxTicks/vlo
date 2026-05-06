import { memo, useEffect, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  Alert,
  Box,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import MusicOffIcon from "@mui/icons-material/MusicOff";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";

import { styled } from "@mui/material/styles";
import {
  CLIP_HEIGHT,
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  TRACK_HEIGHT,
  TRACK_HEADER_WIDTH,
  RULER_HEIGHT,
} from "../constants";
import type {
  BaseClip,
  TimelineClip as TimelineClipType,
} from "../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../types/Components";
import { isBeatMarker } from "../../../types/Components";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { useAsset } from "../../userAssets/publicApi";
import { revealAssetInBrowser } from "../../userAssets/useAssetBrowserRevealStore";
import { useTimelineStore } from "../useTimelineStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { extractTimelineClipAudioAsset } from "../utils/clipAudioExtraction";
import { ThumbnailCanvas } from "./ThumbnailCanvas";
import { TimelineClipOverlayLayer } from "./TimelineClipOverlayLayer";

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
}

function TimelineClipComponent({
  clip,
  isOverlay = false,
  clipOverlays = [],
}: TimelineClipProps) {
  const domRef = useRef<HTMLElement | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<
    { x: number; y: number } | null
  >(null);
  const [isExtractingAudio, setIsExtractingAudio] = useState(false);
  const [isExtractionSnackbarOpen, setIsExtractionSnackbarOpen] = useState(false);

  const startTime = "start" in clip ? (clip as TimelineClipType).start : 0;
  const timelineClip = "start" in clip ? (clip as TimelineClipType) : null;
  const isClipMuted =
    timelineClip !== null && timelineClip.type !== "mask"
      ? timelineClip.isMuted === true
      : false;
  const canMute = timelineClip !== null && timelineClip.type !== "mask";

  // --- SELECTORS ---
  const isSelected = useTimelineStore((state) =>
    state.selectedClipIds.includes(clip.id),
  );

  const isActive = useInteractionStore(
    (state) => state.activeId !== null && state.activeId.includes(clip.id),
  );

  const operation = useInteractionStore((state) => state.operation);

  // 1. Get Track Index
  const trackId = "trackId" in clip ? (clip as TimelineClipType).trackId : "";
  const tracks = useTimelineStore((state) => state.tracks);
  const trackIndex = tracks.findIndex((t) => t.id === trackId);
  const track = tracks[trackIndex];
  const isTrackVisible = track?.isVisible ?? true;
  const clipAsset = useAsset(timelineClip?.assetId);
  const canExtractAudio =
    timelineClip !== null &&
    track !== undefined &&
    !!timelineClip.assetId &&
    timelineClip.type === "video" &&
    clipAsset?.hasAudio !== false;

  const beatMarkersComponent = useTimelineStore((state) => {
    const liveClip = state.clips.find((candidate) => candidate.id === clip.id);
    if (!liveClip || liveClip.type === "mask") return null;
    const markers = (liveClip.components ?? []).find(
      (component): component is MarkersComponent => component.type === "markers",
    );
    if (!markers) return null;
    return markers.parameters.markers.some(isBeatMarker) ? markers : null;
  });
  const canRemoveBeats = beatMarkersComponent !== null;

  // 2. Vertical Position
  const topPos = isOverlay ? 0 : trackIndex * TRACK_HEIGHT + RULER_HEIGHT + 5;

  // 3. Base Geometry Calculations
  const baseWidth =
    (clip.timelineDuration / TICKS_PER_SECOND) * PIXELS_PER_SECOND;
  const baseLeft = (startTime / TICKS_PER_SECOND) * PIXELS_PER_SECOND;

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
    // 2. OR We are Selected and the operation is "move" (Follower)
    const shouldSubscribe = isActive || (isSelected && operation === "move");

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
      else if (state.operation === "move" && isSelected && !transform) {
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
  }, [isActive, operation, clip.id, isOverlay, isSelected, transform]);

  const getBackgroundColor = () => {
    switch (clip.type) {
      case "video":
        return "#2563eb";
      case "image":
        return "#0ea5e9";
      case "text":
        return "#f59e0b";
      case "shape":
        return "#10b981";
      case "audio":
        return "#16a34a";
      default:
        return "#4b5563";
    }
  };

  const ghostOpacity = 1; // Always visible now.

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

  const handleContextDelete = () => {
    const store = useTimelineStore.getState();
    const ids =
      store.selectedClipIds.length > 0 ? store.selectedClipIds : [clip.id];
    ids.forEach((id) => store.removeClip(id));
    store.selectClip(null);
    closeContextMenu();
  };

  const handleContextCopy = () => {
    useTimelineStore.getState().copySelectedClip();
    closeContextMenu();
  };

  const handleContextMute = () => {
    if (canMute) {
      useTimelineStore.getState().toggleClipMute(clip.id);
    }
    closeContextMenu();
  };

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
      store.updateClipComponent(clip.id, beatMarkersComponent.id, (component) => {
        if (component.type !== "markers") return component;
        return {
          ...component,
          parameters: { ...component.parameters, markers: remaining },
        };
      });
    }
    closeContextMenu();
  };

  const handleExtractAudio = async () => {
    if (
      timelineClip === null ||
      track === undefined ||
      !timelineClip.assetId ||
      timelineClip.type !== "video"
    ) {
      closeContextMenu();
      return;
    }

    closeContextMenu();
    setIsExtractingAudio(true);

    try {
      const extractedAsset = await extractTimelineClipAudioAsset(
        timelineClip,
        track,
      );
      if (!extractedAsset) {
        window.alert("No audio track was found for the selected clip.");
      } else {
        revealAssetInBrowser(extractedAsset.id);
        setIsExtractionSnackbarOpen(true);
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to extract clip audio.",
      );
    } finally {
      setIsExtractingAudio(false);
    }
  };

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
          cursor: isOverlay ? "grabbing" : "grab",
          border: "1px solid rgba(255,255,255,0.2)",
          outline: isSelected ? "2px solid #fff" : "2px solid transparent",
          outlineOffset: "-1px",
          opacity: isOverlay
            ? 1
            : isTrackVisible
              ? ghostOpacity
              : ghostOpacity * 0.3,
          zIndex: isDragging ? 38 : isOverlay ? 999 : isSelected ? 10 : 1,
          boxShadow: isDragging ? "0 4px 8px rgba(0,0,0,0.5)" : "none",
          transition: isActive ? "none" : "box-shadow 0.2s, outline-color 0.1s",

          // --- Metrics & Positioning ---
          left: isOverlay
            ? "0px"
            : `calc(
              ${TRACK_HEADER_WIDTH}px + 
              (${baseLeft}px * var(--timeline-zoom, 1)) + 
              var(--drag-delta-x, 0px)
            )`,
          width: `calc(
          (${baseWidth}px * var(--timeline-zoom, 1)) + 
          var(--drag-delta-w, 0px)
        )`,
          top: topPos,
          // Apply transform directly from hook if available (priority) or handled by effect
          transform: transform
            ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
            : undefined,
        } as React.CSSProperties
      }
      data-testid="timeline-clip"
      data-selected={isSelected ? "true" : "false"}
      data-track-visible={isTrackVisible ? "true" : "false"}
    >
      <ThumbnailCanvas clip={clip} isDragging={isDragging} />
      {!isDragging && !isOverlay && timelineClip ? (
        <TimelineClipOverlayLayer
          clip={timelineClip}
          isSelected={isSelected}
          clipOverlays={clipOverlays}
        />
      ) : null}
      {isSelected && !isDragging && !isOverlay && (
        <>
          <ResizeHandle
            id={`resize_left_${clip.id}`}
            clip={clip as TimelineClipType}
            side="left"
          />
          <ResizeHandle
            id={`resize_right_${clip.id}`}
            clip={clip as TimelineClipType}
            side="right"
          />
        </>
      )}

      <Typography
        variant="caption"
        noWrap
        sx={{ fontWeight: "bold", pointerEvents: "none" }}
      >
        {clip.name}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontSize: "0.6rem", opacity: 0.8, pointerEvents: "none" }}
      >
        {(clip.timelineDuration / TICKS_PER_SECOND).toFixed(2)}s
      </Typography>
      <Menu
        open={contextMenuPos !== null}
        onClose={closeContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenuPos
            ? { top: contextMenuPos.y, left: contextMenuPos.x }
            : undefined
        }
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuItem onClick={handleContextDelete}>
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleContextCopy}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
        </MenuItem>
        {canExtractAudio ? (
          <MenuItem
            onClick={() => void handleExtractAudio()}
            disabled={isExtractingAudio}
          >
            <ListItemIcon>
              <GraphicEqIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              {isExtractingAudio ? "Extracting Audio..." : "Extract Audio"}
            </ListItemText>
          </MenuItem>
        ) : null}
        {canMute && (
          <MenuItem onClick={handleContextMute}>
            <ListItemIcon>
              {isClipMuted ? (
                <VolumeUpIcon fontSize="small" />
              ) : (
                <VolumeOffIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText>{isClipMuted ? "Unmute" : "Mute"}</ListItemText>
          </MenuItem>
        )}
        {canRemoveBeats && (
          <MenuItem onClick={handleContextRemoveBeats}>
            <ListItemIcon>
              <MusicOffIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Remove Beats</ListItemText>
          </MenuItem>
        )}
      </Menu>
      <Snackbar
        open={isExtractionSnackbarOpen}
        autoHideDuration={2500}
        onClose={() => setIsExtractionSnackbarOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ zIndex: (theme) => theme.zIndex.tooltip + 1 }}
      >
        <Alert
          onClose={() => setIsExtractionSnackbarOpen(false)}
          severity="success"
          variant="filled"
          sx={{ width: "100%" }}
        >
          Audio Extracted to Asset Browser
        </Alert>
      </Snackbar>
    </ClipRoot>
  );
}

export const TimelineClipItem = memo(TimelineClipComponent);
