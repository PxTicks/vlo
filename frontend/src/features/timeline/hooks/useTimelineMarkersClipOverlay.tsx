import { useCallback, useMemo, useState } from "react";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { createSourceTimeOverlayItem } from "../clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../types/Components";
import { useTimelineStore } from "../useTimelineStore";
import { useTimelineViewStore } from "./useTimelineViewStore";
import { useProjectStore } from "../../project/useProjectStore";
import { getTicksPerFrame } from "../../timelineSelection";
import { buildFrameSnappedSourceTimeDrag } from "../utils/snapDragOverlay";

export const MARKER_COLOR = "#fbc02d";
const MARKER_ICON_FONT_SIZE = 32;
/** Lane "top" sits at 30% of clip height; this offset pulls the icon
 *  up so its top edge is flush with the clip's top edge. */
const MARKER_VERTICAL_OFFSET_PX = -12.33;

interface MarkerMenuState {
  markerId: string;
  x: number;
  y: number;
}

function getMarkersComponent(clip: TimelineClip): MarkersComponent | null {
  if (clip.type === "mask") return null;
  const components = clip.components ?? [];
  return (
    components.find(
      (component): component is MarkersComponent => component.type === "markers",
    ) ?? null
  );
}

const EMPTY_MARKERS: readonly never[] = [];

function useClipMarkersOverlayItems({ clip }: { clip: TimelineClip }) {
  const markersComponent = getMarkersComponent(clip);
  const markers = useMemo(
    () => markersComponent?.parameters.markers ?? EMPTY_MARKERS,
    [markersComponent],
  );
  const componentEnabled = markersComponent?.isEnabled !== false;
  const componentId = markersComponent?.id ?? null;

  const [menuState, setMenuState] = useState<MarkerMenuState | null>(null);
  const closeMenu = useCallback(() => setMenuState(null), []);

  const handleDelete = useCallback(() => {
    if (!menuState || !componentId || clip.type === "mask") {
      closeMenu();
      return;
    }
    const store = useTimelineStore.getState();
    const remaining = markers.filter((m) => m.id !== menuState.markerId);
    if (remaining.length === 0) {
      store.removeClipComponent(clip.id, componentId);
    } else {
      store.updateClipComponent(clip.id, componentId, (component) => {
        if (component.type !== "markers") return component;
        return {
          ...component,
          parameters: { ...component.parameters, markers: remaining },
        };
      });
    }
    closeMenu();
  }, [menuState, componentId, clip.id, clip.type, markers, closeMenu]);

  const items = useMemo(() => {
    if (!componentEnabled || markers.length === 0 || !componentId) return [];

    return markers.map((marker, index) => {
      const isMenuTarget = menuState?.markerId === marker.id;

      const dragHandlers = buildFrameSnappedSourceTimeDrag({
        clip,
        initialSourceTimeTicks: marker.sourceTimeTicks,
        getTicksPerFrame: () =>
          getTicksPerFrame(useProjectStore.getState().config.fps),
        getZoomScale: () => useTimelineViewStore.getState().zoomScale,
        onCommit: (snappedSourceTimeTicks) => {
          useTimelineStore.getState().updateClipComponent(
            clip.id,
            componentId,
            (component) => {
              if (component.type !== "markers") return component;
              return {
                ...component,
                parameters: {
                  ...component.parameters,
                  markers: component.parameters.markers.map((m) =>
                    m.id === marker.id
                      ? { ...m, sourceTimeTicks: snappedSourceTimeTicks }
                      : m,
                  ),
                },
              };
            },
          );
        },
      });

      // Render the shared MUI Menu as a sibling of the FIRST marker's
      // icon. Only one Menu instance ever mounts; it's anchored at the
      // captured click coords via `anchorReference="anchorPosition"`,
      // so its position is independent of which marker triggered it.
      const isMenuRoot = index === 0;

      return createSourceTimeOverlayItem({
        id: `clip-marker:${marker.id}`,
        sourceTimeTicks: marker.sourceTimeTicks,
        lane: "top",
        verticalOffsetPx: MARKER_VERTICAL_OFFSET_PX,
        onContextMenu: (event) => {
          setMenuState({
            markerId: marker.id,
            x: event.clientX,
            y: event.clientY,
          });
        },
        drag: dragHandlers,
        content: (
          <>
            <ArrowDropDownIcon
              sx={{
                color: MARKER_COLOR,
                fontSize: MARKER_ICON_FONT_SIZE,
                filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))",
                cursor: "default",
                outline: isMenuTarget
                  ? `2px solid ${MARKER_COLOR}`
                  : undefined,
                outlineOffset: 2,
                pointerEvents: "none",
              }}
            />
            {isMenuRoot && (
              <Menu
                open={menuState !== null}
                onClose={closeMenu}
                anchorReference="anchorPosition"
                anchorPosition={
                  menuState
                    ? { top: menuState.y, left: menuState.x }
                    : undefined
                }
                onContextMenu={(e) => e.preventDefault()}
              >
                <MenuItem onClick={handleDelete}>
                  <ListItemIcon>
                    <DeleteOutlineIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Delete marker</ListItemText>
                </MenuItem>
              </Menu>
            )}
          </>
        ),
      });
    });
  }, [
    clip,
    componentEnabled,
    componentId,
    markers,
    menuState,
    closeMenu,
    handleDelete,
  ]);

  return items;
}

const TIMELINE_MARKERS_CLIP_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-markers-overlay",
  useItems: useClipMarkersOverlayItems,
};

export function useTimelineMarkersClipOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_MARKERS_CLIP_OVERLAY;
}
