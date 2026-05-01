import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { TimelineClip } from "../../types/TimelineTypes";

export type TimelineClipOverlayVisibility = "always" | "selected";
export type TimelineClipOverlayLane = "top" | "middle" | "bottom";
export type TimelineClipOverlayEdge = "start" | "end";

export interface TimelineEndpointOverlayPlacement {
  kind: "endpoint";
  edge: TimelineClipOverlayEdge;
  lane: TimelineClipOverlayLane;
  insetPx: number;
  order: number;
}

export interface TimelineSourceTimeOverlayPlacement {
  kind: "sourceTime";
  sourceTimeTicks: number;
  lane: TimelineClipOverlayLane;
  offsetPx: number;
  verticalOffsetPx: number;
}

export interface TimelineLayerTimeOverlayPlacement {
  kind: "layerTime";
  transformId: string;
  layerInputTicks: number;
  lane: TimelineClipOverlayLane;
  offsetPx: number;
  verticalOffsetPx: number;
}

export type TimelineClipOverlayPlacement =
  | TimelineEndpointOverlayPlacement
  | TimelineSourceTimeOverlayPlacement
  | TimelineLayerTimeOverlayPlacement;

export interface TimelineClipOverlayRenderContext {
  clip: TimelineClip;
  isSelected: boolean;
  item: TimelineClipOverlayItem;
}

export interface TimelineClipOverlayDragContext
  extends TimelineClipOverlayRenderContext {
  event: PointerEvent;
  /** The overlay item's root DOM element. Use this for direct DOM
   *  effects during drag (e.g. setting CSS variables). */
  targetElement: HTMLElement;
  clipLocalX: number;
  visualTimeTicks: number;
  sourceTimeTicks: number;
  deltaClipX: number;
  deltaVisualTimeTicks: number;
  deltaSourceTimeTicks: number;
}

export interface TimelineClipOverlayItemDrag {
  onDragStart?: (context: TimelineClipOverlayDragContext) => void;
  onDrag?: (context: TimelineClipOverlayDragContext) => void;
  onDragEnd?: (context: TimelineClipOverlayDragContext) => void;
}

export interface TimelineClipOverlayItem {
  id: string;
  content: ReactNode;
  visibility: TimelineClipOverlayVisibility;
  placement: TimelineClipOverlayPlacement;
  minClipWidthPx?: number;
  onClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  drag?: TimelineClipOverlayItemDrag;
}

export interface TimelineClipOverlaySourceProps {
  clip: TimelineClip;
  isSelected: boolean;
}

export interface TimelineClipOverlayDefinition {
  id: string;
  useItems: (
    props: TimelineClipOverlaySourceProps,
  ) => readonly TimelineClipOverlayItem[];
}

interface TimelineClipOverlayItemBaseInput {
  id: string;
  content: ReactNode;
  visibility?: TimelineClipOverlayVisibility;
  minClipWidthPx?: number;
  onClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  drag?: TimelineClipOverlayItemDrag;
}

interface CreateEndpointOverlayItemInput
  extends TimelineClipOverlayItemBaseInput {
  edge: TimelineClipOverlayEdge;
  lane?: TimelineClipOverlayLane;
  insetPx?: number;
  order?: number;
}

interface CreateSourceTimeOverlayItemInput
  extends TimelineClipOverlayItemBaseInput {
  sourceTimeTicks: number;
  lane?: TimelineClipOverlayLane;
  offsetPx?: number;
  verticalOffsetPx?: number;
}

interface CreateLayerTimeOverlayItemInput
  extends TimelineClipOverlayItemBaseInput {
  transformId: string;
  layerInputTicks: number;
  lane?: TimelineClipOverlayLane;
  offsetPx?: number;
  verticalOffsetPx?: number;
}

function withSharedDefaults(
  item: TimelineClipOverlayItem,
): TimelineClipOverlayItem {
  return {
    ...item,
    visibility: item.visibility ?? "always",
  };
}

export function createEndpointOverlayItem(
  input: CreateEndpointOverlayItemInput,
): TimelineClipOverlayItem {
  return withSharedDefaults({
    id: input.id,
    content: input.content,
    visibility: input.visibility ?? "always",
    minClipWidthPx: input.minClipWidthPx,
    onClick: input.onClick,
    onContextMenu: input.onContextMenu,
    drag: input.drag,
    placement: {
      kind: "endpoint",
      edge: input.edge,
      lane: input.lane ?? "middle",
      insetPx: input.insetPx ?? 8,
      order: input.order ?? 0,
    },
  });
}

export function createSourceTimeOverlayItem(
  input: CreateSourceTimeOverlayItemInput,
): TimelineClipOverlayItem {
  return withSharedDefaults({
    id: input.id,
    content: input.content,
    visibility: input.visibility ?? "always",
    minClipWidthPx: input.minClipWidthPx,
    onClick: input.onClick,
    onContextMenu: input.onContextMenu,
    drag: input.drag,
    placement: {
      kind: "sourceTime",
      sourceTimeTicks: input.sourceTimeTicks,
      lane: input.lane ?? "middle",
      offsetPx: input.offsetPx ?? 0,
      verticalOffsetPx: input.verticalOffsetPx ?? 0,
    },
  });
}

export function createLayerTimeOverlayItem(
  input: CreateLayerTimeOverlayItemInput,
): TimelineClipOverlayItem {
  return withSharedDefaults({
    id: input.id,
    content: input.content,
    visibility: input.visibility ?? "always",
    minClipWidthPx: input.minClipWidthPx,
    onClick: input.onClick,
    onContextMenu: input.onContextMenu,
    drag: input.drag,
    placement: {
      kind: "layerTime",
      transformId: input.transformId,
      layerInputTicks: input.layerInputTicks,
      lane: input.lane ?? "middle",
      offsetPx: input.offsetPx ?? 0,
      verticalOffsetPx: input.verticalOffsetPx ?? 0,
    },
  });
}
