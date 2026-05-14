import type { Container, FederatedPointerEvent } from "pixi.js";
import type { MaskTimelineClip } from "../../../../../types/TimelineTypes";
import type { MaskLayoutState } from "../../../../masks/model/maskFactory";
import type { PositionPathDragState } from "../../../../transformations/utils/positionPathDrag";

export type MaskInteractionMode =
  | "idle"
  | "draw"
  | "translate"
  | "scale"
  | "rotate"
  | "brush"
  | "recordPath"
  | "editPath";

export interface MaskLayoutTransformIds {
  position: string | null;
  scale: string | null;
  rotation: string | null;
}

export interface BrushStrokeState {
  tool: "paint" | "erase";
  lastCanvasPoint: { x: number; y: number };
  canvasSize: { width: number; height: number };
  radius: number;
  /** Local id of the mask (without the parent clip prefix). */
  maskLocalId: string;
}

export interface MaskInteractionState {
  active: boolean;
  mode: MaskInteractionMode;
  clipId: string | null;
  maskId: string | null;
  handle: string | null;
  startLocal: { x: number; y: number };
  startLayout: MaskLayoutState | null;
  startBaseSize: { width: number; height: number } | null;
  initialAngle: number;
  transformIds: MaskLayoutTransformIds;
  didMove: boolean;
  brush: BrushStrokeState | null;
  path: PositionPathDragState | null;
}

export interface LiveMaskLayoutPreview {
  clipId: string;
  maskId: string;
  layout: MaskLayoutState;
}

export interface MaskInteractionTarget {
  clipId: string;
  maskClip: MaskTimelineClip;
  maskLocalId: string;
}

export interface MaskInteractionHandlers {
  onSpritePointerDown: (e: FederatedPointerEvent) => boolean;
  onMaskPointerDown: (e: FederatedPointerEvent) => boolean;
  onHandlePointerDown: (e: FederatedPointerEvent, key: string) => void;
  gizmoTarget: Container | null;
  isMaskGizmoVisible: boolean;
}

export function createInitialMaskInteractionState(): MaskInteractionState {
  return {
    active: false,
    mode: "idle",
    clipId: null,
    maskId: null,
    handle: null,
    startLocal: { x: 0, y: 0 },
    startLayout: null,
    startBaseSize: null,
    initialAngle: 0,
    transformIds: {
      position: null,
      scale: null,
      rotation: null,
    },
    didMove: false,
    brush: null,
    path: null,
  };
}
