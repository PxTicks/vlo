import type {
  ClipTransform,
  TimelineClip,
  Transition,
  TransitionType,
} from "../../../types/TimelineTypes";
import type {
  ControlDefinition,
  LayoutGroup,
} from "../../panelUI/types";

export type TransitionZOrder =
  | "default"
  | "outgoing-on-top"
  | "incoming-on-top";

export interface TransitionColorLayerInstruction {
  id?: string;
  color: string;
  zIndexOffset?: number;
}

export interface TransitionFrameResult {
  outgoingTransforms?: readonly ClipTransform[];
  incomingTransforms?: readonly ClipTransform[];
  colorLayers?: readonly TransitionColorLayerInstruction[];
  zOrder?: TransitionZOrder;
}

export interface TransitionRenderContext {
  transition: Transition;
  outgoingClip: TimelineClip;
  incomingClip: TimelineClip;
  progress: number;
  startTick: number;
  endTick: number;
  durationTicks: number;
  presentationTick: number;
  fps: number;
  logicalDimensions: { width: number; height: number };
}

export interface TransitionDefinition {
  type: TransitionType;
  label: string;
  glyph: string;
  parameters: Record<string, unknown>;
  schemaVersion?: number;
  uiConfig: {
    groups: readonly LayoutGroup[];
  };
  /**
   * Legacy built-in flag. Prefer `zOrder` for extension-aware definitions.
   */
  hijackZOrder?: boolean;
  zOrder?: TransitionZOrder;
  renderFrame?: (context: TransitionRenderContext) => TransitionFrameResult;
  extension?: {
    ownerId: string;
    contributionId: string;
    validateParameters: (
      parameters: Readonly<Record<string, unknown>>,
      schemaVersion: number,
    ) => boolean;
  };
}

export type TransitionControlDefinition = ControlDefinition;
