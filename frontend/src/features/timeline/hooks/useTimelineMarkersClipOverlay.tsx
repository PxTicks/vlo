import { useMemo, useSyncExternalStore } from "react";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { contextMenuService } from "../../../core/shell/contextMenuService";
import { useHostContextMenu } from "../../../core/shell/useHostContextMenu";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";
import type { TimelineClipOverlayDefinition } from "../clipOverlayApi";
import { createSourceTimeOverlayItem } from "../clipOverlayApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../types/Components";
import { isBeatMarker } from "../../../types/Components";
import { toExtensionClipSnapshot } from "../api";
import { useTimelineStore } from "../useTimelineStore";
import { useTimelineViewStore } from "./useTimelineViewStore";
import { useProjectStore } from "../../project/useProjectStore";
import { getTicksPerFrame } from "../../timelineSelection";
import { buildFrameSnappedSourceTimeDrag } from "../utils/snapDragOverlay";

export const MARKER_COLOR = "#fbc02d";
export const BEAT_MARKER_COLOR = "#00e5ff";
const MARKER_ICON_FONT_SIZE = 32;
/** Lane "top" sits at 30% of clip height; this offset pulls the icon
 *  up so its top edge is flush with the clip's top edge. */
const MARKER_VERTICAL_OFFSET_PX = -12.33;

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

/** The marker whose shell context menu is open for this clip, if any. */
function getActiveMenuMarkerId(clipId: string): string | null {
  const active = contextMenuService.getActive();
  if (active === null || active.menuId !== "timeline.marker.context") {
    return null;
  }
  const subject = active.subject as HostMenuSubject<"timeline.marker.context">;
  return subject.clip.id === clipId ? subject.marker.id : null;
}

function useClipMarkersOverlayItems({ clip }: { clip: TimelineClip }) {
  const markersComponent = getMarkersComponent(clip);
  const markers = useMemo(
    () => markersComponent?.parameters.markers ?? EMPTY_MARKERS,
    [markersComponent],
  );
  const componentEnabled = markersComponent?.isEnabled !== false;
  const componentId = markersComponent?.id ?? null;

  // The open-menu outline follows the shell context-menu service; the menu
  // itself renders through the app-shell MenuHostMount. The snapshot is the
  // clip-scoped target marker (a primitive), so this per-clip hook does not
  // re-render unaffected clips when unrelated menus open or close.
  const menuTargetMarkerId = useSyncExternalStore(
    (listener) => contextMenuService.subscribe(listener),
    () => getActiveMenuMarkerId(clip.id),
    () => getActiveMenuMarkerId(clip.id),
  );
  const showContextMenu = useHostContextMenu();

  const items = useMemo(() => {
    if (!componentEnabled || markers.length === 0 || !componentId) return [];

    return markers.map((marker) => {
      const isMenuTarget = menuTargetMarkerId === marker.id;

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

      const isBeat = isBeatMarker(marker);
      const markerColor = isBeat ? BEAT_MARKER_COLOR : MARKER_COLOR;

      return createSourceTimeOverlayItem({
        id: `clip-marker:${marker.id}`,
        sourceTimeTicks: marker.sourceTimeTicks,
        lane: "top",
        verticalOffsetPx: MARKER_VERTICAL_OFFSET_PX,
        onContextMenu: (event) => {
          showContextMenu({
            menuId: "timeline.marker.context",
            subject: {
              slot: "timeline.marker.context",
              marker: {
                id: marker.id,
                sourceTimeTicks: marker.sourceTimeTicks,
                kind: isBeat ? "beat" : "marker",
              },
              clip: toExtensionClipSnapshot(clip),
            },
            items: [
              {
                kind: "command",
                id: "delete-marker",
                command: "timeline.marker.delete",
                subject: { clipId: clip.id, markerId: marker.id },
                icon: <DeleteOutlineIcon fontSize="small" />,
                group: "1_marker",
              },
            ],
            position: { x: event.clientX, y: event.clientY },
          });
        },
        drag: dragHandlers,
        content: (
          <ArrowDropDownIcon
            sx={{
              color: markerColor,
              fontSize: MARKER_ICON_FONT_SIZE,
              filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))",
              cursor: "default",
              outline: isMenuTarget
                ? `2px solid ${markerColor}`
                : undefined,
              outlineOffset: 2,
              pointerEvents: "none",
            }}
          />
        ),
      });
    });
  }, [clip, componentEnabled, componentId, markers, menuTargetMarkerId, showContextMenu]);

  return items;
}

const TIMELINE_MARKERS_CLIP_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-markers-overlay",
  useItems: useClipMarkersOverlayItems,
};

export function useTimelineMarkersClipOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_MARKERS_CLIP_OVERLAY;
}
