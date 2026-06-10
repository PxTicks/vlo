import { memo, useMemo, useRef } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  calculateClipTime,
  mapSourceTimeToVisualTime,
} from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { ticksToPx, pxToTicks } from "../utils/pixelGrid";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import type { TimelineClipPresentation } from "../utils/clipPresentation";
import {
  resolveClipOffsetForPresentationOffset,
  resolvePresentationOffsetForClipOffset,
} from "../utils/clipPresentation";
import type {
  TimelineClipOverlayDefinition,
  TimelineClipOverlayDragContext,
  TimelineClipOverlayItem,
  TimelineClipOverlayRenderContext,
  TimelineSourceTimeOverlayPlacement,
} from "../clipOverlayApi";

interface TimelineClipOverlayLayerProps {
  clip: TimelineClip;
  isSelected: boolean;
  clipOverlays?: readonly TimelineClipOverlayDefinition[];
  presentation?: TimelineClipPresentation;
}

interface TimelineClipOverlayItemNodeProps {
  clip: TimelineClip;
  isSelected: boolean;
  item: TimelineClipOverlayItem;
  style?: CSSProperties;
  presentation?: TimelineClipPresentation;
}

interface TimelineClipOverlayEndpointGroupProps {
  clip: TimelineClip;
  isSelected: boolean;
  items: readonly TimelineClipOverlayItem[];
  presentation?: TimelineClipPresentation;
}

interface TimelineClipOverlayItemCollectionProps {
  clip: TimelineClip;
  isSelected: boolean;
  items: readonly TimelineClipOverlayItem[];
  presentation?: TimelineClipPresentation;
}

type TimelineSourceTimeOverlayItem = TimelineClipOverlayItem & {
  placement: TimelineSourceTimeOverlayPlacement;
};

const LANE_TOP_OFFSET = "30%";
const LANE_MIDDLE_OFFSET = "50%";
const LANE_BOTTOM_OFFSET = "70%";

const OverlayLayerRoot = styled(Box)({
  position: "absolute",
  inset: 0,
  zIndex: 12,
  pointerEvents: "none",
});

const EndpointGroupRoot = styled(Box)({
  position: "absolute",
  display: "flex",
  gap: 4,
  pointerEvents: "none",
  zIndex: 12,
});

const OverlayItemRoot = styled(Box)({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 12,
});

function toBasePixels(ticks: number): number {
  return ticksToPx(ticks, 1);
}

function toPresentationOffsetTicks(
  clipLocalX: number,
  zoomScale: number,
): number {
  return Math.round(pxToTicks(clipLocalX, zoomScale));
}

function getLanePosition(lane: "top" | "middle" | "bottom"): {
  top: string;
  translateY: string;
} {
  switch (lane) {
    case "top":
      return { top: LANE_TOP_OFFSET, translateY: "-50%" };
    case "bottom":
      return { top: LANE_BOTTOM_OFFSET, translateY: "-50%" };
    case "middle":
    default:
      return { top: LANE_MIDDLE_OFFSET, translateY: "-50%" };
  }
}

function isItemVisible(
  item: TimelineClipOverlayItem,
  isSelected: boolean,
  clipWidthPx: number | null,
): boolean {
  if (item.visibility === "selected" && !isSelected) {
    return false;
  }

  if (
    clipWidthPx !== null &&
    item.minClipWidthPx !== undefined &&
    clipWidthPx < item.minClipWidthPx
  ) {
    return false;
  }

  return true;
}

function isSourceTimeOverlayItem(
  item: TimelineClipOverlayItem,
): item is TimelineSourceTimeOverlayItem {
  return item.placement.kind === "sourceTime";
}

function createRenderContext(
  clip: TimelineClip,
  isSelected: boolean,
  item: TimelineClipOverlayItem,
): TimelineClipOverlayRenderContext {
  return { clip, isSelected, item };
}

function buildDragContext(
  clip: TimelineClip,
  isSelected: boolean,
  item: TimelineClipOverlayItem,
  event: PointerEvent,
  targetElement: HTMLElement,
  startClipLocalX: number,
  startPresentationOffsetTicks: number,
  startVisualTimeTicks: number,
  startSourceTimeTicks: number,
  clipLocalX: number,
  zoomScale: number,
  presentation?: TimelineClipPresentation,
): TimelineClipOverlayDragContext {
  const presentationOffsetTicks = toPresentationOffsetTicks(
    clipLocalX,
    zoomScale,
  );
  const visualTimeTicks = resolveClipOffsetForPresentationOffset(
    presentation,
    presentationOffsetTicks,
  );
  const sourceTimeTicks = calculateClipTime(clip, visualTimeTicks, true);

  return {
    ...createRenderContext(clip, isSelected, item),
    event,
    targetElement,
    clipLocalX,
    presentationOffsetTicks,
    visualTimeTicks,
    sourceTimeTicks,
    deltaClipX: clipLocalX - startClipLocalX,
    deltaPresentationOffsetTicks:
      presentationOffsetTicks - startPresentationOffsetTicks,
    deltaVisualTimeTicks: visualTimeTicks - startVisualTimeTicks,
    deltaSourceTimeTicks: sourceTimeTicks - startSourceTimeTicks,
    mapPresentationOffsetToClipOffset: (offset) =>
      resolveClipOffsetForPresentationOffset(presentation, offset),
    mapClipOffsetToPresentationOffset: (offset) =>
      resolvePresentationOffsetForClipOffset(presentation, offset),
  };
}

function getClipLocalX(
  event: PointerEvent,
  currentTarget: HTMLElement,
): number | null {
  const clipRoot = currentTarget.closest('[data-testid="timeline-clip"]');
  if (!(clipRoot instanceof HTMLElement)) {
    return null;
  }

  const rect = clipRoot.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  return Math.max(0, Math.min(localX, rect.width));
}

function TimelineClipOverlayItemNode({
  clip,
  isSelected,
  item,
  style,
  presentation,
}: TimelineClipOverlayItemNodeProps) {
  const isInteractive =
    item.onClick !== undefined ||
    item.drag !== undefined ||
    item.onContextMenu !== undefined;
  const zoomScale = useTimelineViewStore((state) =>
    item.drag ? state.zoomScale : 1,
  );
  const suppressClickRef = useRef(false);
  const dragStartRef = useRef<{
    clipLocalX: number;
    presentationOffsetTicks: number;
    visualTimeTicks: number;
    sourceTimeTicks: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isInteractive) return;

    event.stopPropagation();
    suppressClickRef.current = false;

    const clipLocalX = getClipLocalX(event.nativeEvent, event.currentTarget);
    if (clipLocalX === null) {
      return;
    }

    if (item.drag) {
      const presentationOffsetTicks = toPresentationOffsetTicks(
        clipLocalX,
        zoomScale,
      );
      const visualTimeTicks = resolveClipOffsetForPresentationOffset(
        presentation,
        presentationOffsetTicks,
      );
      const sourceTimeTicks = calculateClipTime(clip, visualTimeTicks, true);

      dragStartRef.current = {
        clipLocalX,
        presentationOffsetTicks,
        visualTimeTicks,
        sourceTimeTicks,
        moved: false,
      };

      event.currentTarget.setPointerCapture(event.pointerId);
      item.drag.onDragStart?.(
        buildDragContext(
          clip,
          isSelected,
          item,
          event.nativeEvent,
          event.currentTarget,
          clipLocalX,
          presentationOffsetTicks,
          visualTimeTicks,
          sourceTimeTicks,
          clipLocalX,
          zoomScale,
          presentation,
        ),
      );
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!item.drag || dragStart === null) {
      return;
    }

    event.stopPropagation();

    const clipLocalX = getClipLocalX(event.nativeEvent, event.currentTarget);
    if (clipLocalX === null) {
      return;
    }

    if (Math.abs(clipLocalX - dragStart.clipLocalX) > 2) {
      dragStart.moved = true;
      suppressClickRef.current = true;
    }

    item.drag.onDrag?.(
      buildDragContext(
        clip,
        isSelected,
        item,
        event.nativeEvent,
        event.currentTarget,
        dragStart.clipLocalX,
        dragStart.presentationOffsetTicks,
        dragStart.visualTimeTicks,
        dragStart.sourceTimeTicks,
        clipLocalX,
        zoomScale,
        presentation,
      ),
    );
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!item.drag || dragStart === null) {
      return;
    }

    event.stopPropagation();

    const clipLocalX = getClipLocalX(event.nativeEvent, event.currentTarget);
    if (clipLocalX === null) {
      dragStartRef.current = null;
      return;
    }

    item.drag.onDragEnd?.(
      buildDragContext(
        clip,
        isSelected,
        item,
        event.nativeEvent,
        event.currentTarget,
        dragStart.clipLocalX,
        dragStart.presentationOffsetTicks,
        dragStart.visualTimeTicks,
        dragStart.sourceTimeTicks,
        clipLocalX,
        zoomScale,
        presentation,
      ),
    );

    dragStartRef.current = null;
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!item.drag || dragStart === null) {
      return;
    }

    event.stopPropagation();

    item.drag.onDragEnd?.(
      buildDragContext(
        clip,
        isSelected,
        item,
        event.nativeEvent,
        event.currentTarget,
        dragStart.clipLocalX,
        dragStart.presentationOffsetTicks,
        dragStart.visualTimeTicks,
        dragStart.sourceTimeTicks,
        dragStart.clipLocalX,
        zoomScale,
        presentation,
      ),
    );

    dragStartRef.current = null;
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!item.onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    item.onContextMenu(event);
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isInteractive) {
      return;
    }

    event.stopPropagation();

    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    item.onClick?.();
  };

  return (
    <OverlayItemRoot
      data-testid="timeline-clip-overlay-item"
      data-overlay-item-id={item.id}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={style}
      sx={{
        pointerEvents: isInteractive ? "auto" : "none",
      }}
    >
      {item.content}
    </OverlayItemRoot>
  );
}

function TimelineClipOverlayEndpointGroup({
  clip,
  isSelected,
  items,
  presentation,
}: TimelineClipOverlayEndpointGroupProps) {
  const sortedItems = useMemo(
    () =>
      items
        .map((item, index) => ({ item, index }))
        .sort((leftItem, rightItem) => {
          const leftOrder =
            leftItem.item.placement.kind === "endpoint"
              ? leftItem.item.placement.order
              : 0;
          const rightOrder =
            rightItem.item.placement.kind === "endpoint"
              ? rightItem.item.placement.order
              : 0;

          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          return leftItem.index - rightItem.index;
        })
        .map(({ item }) => item),
    [items],
  );
  if (sortedItems.length === 0) {
    return null;
  }

  const firstPlacement = sortedItems[0].placement;
  if (firstPlacement.kind !== "endpoint") {
    return null;
  }

  const { top, translateY } = getLanePosition(firstPlacement.lane);
  const edgeStyle =
    firstPlacement.edge === "start"
      ? { left: 0, flexDirection: "row" as const }
      : { right: 0, flexDirection: "row-reverse" as const };

  return (
    <EndpointGroupRoot
      style={{
        top,
        transform: `translateY(${translateY})`,
        ...edgeStyle,
      }}
    >
      {sortedItems.map((item, index) => {
        const placement = item.placement;
        if (placement.kind !== "endpoint") {
          return null;
        }

        const marginStyle =
          placement.edge === "start"
            ? index === 0
              ? { marginLeft: placement.insetPx, position: "relative" as const }
              : { position: "relative" as const }
            : index === 0
              ? {
                  marginRight: placement.insetPx,
                  position: "relative" as const,
                }
              : { position: "relative" as const };

        return (
          <TimelineClipOverlayItemNode
            key={item.id}
            clip={clip}
            isSelected={isSelected}
            item={item}
            style={marginStyle}
            presentation={presentation}
          />
        );
      })}
    </EndpointGroupRoot>
  );
}

function TimelineClipOverlayItemCollection({
  clip,
  isSelected,
  items,
  presentation,
}: TimelineClipOverlayItemCollectionProps) {
  const endpointGroups = useMemo(() => {
    const groups = new Map<string, TimelineClipOverlayItem[]>();

    items.forEach((item) => {
      if (item.placement.kind !== "endpoint") {
        return;
      }

      const key = `${item.placement.edge}:${item.placement.lane}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    });

    return [...groups.entries()];
  }, [items]);

  const timedItems = useMemo(
    () => items.filter(isSourceTimeOverlayItem),
    [items],
  );

  return (
    <>
      {endpointGroups.map(([groupKey, groupItems]) => (
        <TimelineClipOverlayEndpointGroup
          key={groupKey}
          clip={clip}
          isSelected={isSelected}
          items={groupItems}
          presentation={presentation}
        />
      ))}

      {timedItems.map((item) => {
        const placement = item.placement;
        const { top, translateY } = getLanePosition(placement.lane);
        const visualTicks = mapSourceTimeToVisualTime(
          clip,
          placement.sourceTimeTicks,
        );
        const offsetPx = placement.offsetPx;
        const verticalOffsetPx = placement.verticalOffsetPx;

        const presentationTicks = resolvePresentationOffsetForClipOffset(
          presentation,
          visualTicks,
        );
        const baseLeftPx = toBasePixels(presentationTicks);

        return (
          <TimelineClipOverlayItemNode
            key={item.id}
            clip={clip}
            isSelected={isSelected}
            item={item}
            presentation={presentation}
            style={{
              position: "absolute",
              // Subtract the parent clip's `--drag-delta-x` so timed items
              // stay anchored to their committed content position during a
              // live left-edge resize. The clip's `left` is shifted by
              // `+var(--drag-delta-x)` while the model is unchanged, so
              // without this cancellation the marker would ride along with
              // the clip and snap back only on commit.
              // Same trick used by ThumbnailCanvas to keep thumbnails
              // screen-stable during a crop.
              left: `calc((${baseLeftPx}px * var(--timeline-zoom, 1)) + ${offsetPx}px - var(--drag-delta-x, 0px))`,
              top: `calc(${top} + ${verticalOffsetPx}px)`,
              transform: `translate(calc(-50% + var(--overlay-drag-dx, 0px)), ${translateY})`,
            }}
          />
        );
      })}
    </>
  );
}

function TimelineClipWidthSensitiveItemCollection({
  clip,
  isSelected,
  items,
  presentation,
}: TimelineClipOverlayItemCollectionProps) {
  const zoomScale = useTimelineViewStore((state) => state.zoomScale);
  const displayDuration = presentation?.duration ?? clip.timelineDuration;
  const clipWidthPx = toBasePixels(displayDuration) * zoomScale;
  const visibleItems = useMemo(
    () => items.filter((item) => isItemVisible(item, isSelected, clipWidthPx)),
    [clipWidthPx, isSelected, items],
  );

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <TimelineClipOverlayItemCollection
      clip={clip}
      isSelected={isSelected}
      items={visibleItems}
      presentation={presentation}
    />
  );
}

function TimelineClipOverlaySourceSlot({
  clip,
  isSelected,
  definition,
  presentation,
}: TimelineClipOverlayLayerProps & {
  definition: TimelineClipOverlayDefinition;
}) {
  const items = definition.useItems({ clip, isSelected });
  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.minClipWidthPx === undefined &&
          isItemVisible(item, isSelected, null),
      ),
    [isSelected, items],
  );
  const widthSensitiveItems = useMemo(
    () => items.filter((item) => item.minClipWidthPx !== undefined),
    [items],
  );

  if (visibleItems.length === 0 && widthSensitiveItems.length === 0) {
    return null;
  }

  return (
    <>
      {visibleItems.length > 0 ? (
        <TimelineClipOverlayItemCollection
          clip={clip}
          isSelected={isSelected}
          items={visibleItems}
          presentation={presentation}
        />
      ) : null}
      {widthSensitiveItems.length > 0 ? (
        <TimelineClipWidthSensitiveItemCollection
          clip={clip}
          isSelected={isSelected}
          items={widthSensitiveItems}
          presentation={presentation}
        />
      ) : null}
    </>
  );
}

function TimelineClipOverlayLayerComponent({
  clip,
  isSelected,
  clipOverlays = [],
  presentation,
}: TimelineClipOverlayLayerProps) {
  if (clipOverlays.length === 0) {
    return null;
  }

  return (
    <OverlayLayerRoot data-testid="timeline-clip-overlay-layer">
      {clipOverlays.map((definition) => (
        <TimelineClipOverlaySourceSlot
          key={definition.id}
          clip={clip}
          isSelected={isSelected}
          definition={definition}
          presentation={presentation}
        />
      ))}
    </OverlayLayerRoot>
  );
}

export const TimelineClipOverlayLayer = memo(TimelineClipOverlayLayerComponent);
