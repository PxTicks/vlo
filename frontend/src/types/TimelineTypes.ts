import type { ClipComponentBase } from "./ClipComponents";
import type { Component } from "./Components";

export type TrackType = "visual" | "audio" | "prompt" | "effects" | "mask";

export type ClipType = "video" | "image" | "audio" | "text" | "shape" | "mask";

export type TextAlignment = "left" | "center" | "right";

export interface TextClipData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fill: string;
  align: TextAlignment;
}

export interface TimelineSelection {
  start: number;
  end?: number;
  clips: TimelineClip[];
  tracks?: TimelineTrack[];
  /**
   * Optional workflow-provided guidance shown while the selection is being made.
   */
  message?: string;
  /**
   * Optional overlay filter that limits renders/extractions to an explicit set
   * of track ids while preserving the original `tracks` metadata.
   * When omitted or empty, consumers should treat the selection as "all tracks".
   */
  includedTrackIds?: string[];
  /**
   * Effective FPS used for renders/extractions from this selection.
   * When omitted, consumers fall back to project FPS.
   */
  fps?: number;
  /**
   * Optional frame-step constraint for AI workflows that require frame counts
   * matching `frameStep * n + 1` (for integer n). Defaults to 1.
   */
  frameStep?: number;
}

export interface ClipTransform {
  id: string;
  type: string;
  isEnabled: boolean;
  templateId?: string;
  parameters: Record<string, unknown>;
  /** Shared keyframe times (in transform-local input ticks) for all controls in this group.
   *  This is the primary source of truth for keyframe existence — independent of whether
   *  any parameter is stored as a scalar (constant shortcut) or SplineParameter. */
  keyframeTimes?: number[];
}

export type ClipMaskType =
  | "circle"
  | "rectangle"
  | "triangle"
  | "sam2"
  | "generation"
  | "brush";
export type ClipMaskMode = "apply" | "preview";
export type MaskBooleanOperator = "union" | "intersect" | "subtract";

export interface MaskBooleanMaskRefExpression {
  kind: "mask_ref";
  maskId: string;
}

export interface MaskBooleanOperationExpression {
  kind: "operation";
  operator: MaskBooleanOperator;
  left: MaskBooleanExpression;
  right: MaskBooleanExpression;
}

export type MaskBooleanExpression =
  | MaskBooleanMaskRefExpression
  | MaskBooleanOperationExpression;

export interface ClipMaskParameters {
  baseWidth: number;
  baseHeight: number;
}

/**
 * Tight bounding box (in brush-canvas coordinates) of the painted region for
 * a brush mask. Used to size the gizmo and the asset-mask sprite to just the
 * painted area rather than the full canvas extent.
 */
export interface BrushPaintedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClipMaskPoint {
  x: number; // normalized [0, 1] relative to clip width
  y: number; // normalized [0, 1] relative to clip height
  label: 0 | 1; // 1 = positive/include, 0 = negative/exclude
  /** Clip-relative input/source time (ticks), transformation-faithful. */
  timeTicks: number;
}

/**
 * Optional source-time window in which a spatial mask is active. Outside the
 * window the mask becomes a no-op (rendered as if absent / pre-generation
 * SAM2). Times are stored in the parent clip's source-tick domain so they
 * survive speed/time transforms.
 */
export interface MaskActiveRange {
  startSourceTicks: number;
  endSourceTicks: number;
}

export interface ClipMask extends ClipComponentBase<ClipMaskParameters> {
  type: ClipMaskType;
  mode: ClipMaskMode;
  inverted: boolean;
  /** Optional per-mask growth applied to SAM2 masks before composition. */
  sam2GrowAmount?: number;
  /** Optional point prompts for SAM2 masks. */
  maskPoints?: ClipMaskPoint[];
  /** Linked generated mask asset for SAM2 runtime masking. */
  sam2MaskAssetId?: string;
  /** Hash of points used for last generated SAM2 mask asset. */
  sam2GeneratedPointsHash?: string;
  /** Epoch ms of the last successful SAM2 generation. */
  sam2LastGeneratedAt?: number;
  /** Linked mask asset from generation pipeline. */
  generationMaskAssetId?: string;
  /** Linked PNG asset for brush masks (red-on-black bitmap). */
  brushMaskAssetId?: string;
  /**
   * Painted region bounds (brush-canvas coords) for brush masks. Drives the
   * gizmo size and the composited asset-mask sprite's content rect so the
   * mask wraps the painted region rather than the full canvas.
   */
  brushPaintedBounds?: BrushPaintedBounds;
  /**
   * When set, the mask is only active inside this source-time window.
   * Absent means active for the entire clip.
   */
  activeRange?: MaskActiveRange;
  /**
   * Optional transform stack so a mask can be treated as a clip-like entity.
   * Timing is inherited from its parent clip at runtime.
   */
  transformations?: ClipTransform[];
}

export interface BaseClip {
  id: string;
  type: ClipType;

  // --- ASSET DATA ---
  assetId?: string;
  name: string;
  sourceDuration: number | null; // The full source length in ticks; null means unbounded (e.g. still images)

  // --- TRANSFORMED TIME (In Ticks) ---
  transformedDuration: number; // The duration of the clip if the entire source was played with current transformations
  transformedOffset: number; // The amount of "transformed time" trimmed from the start

  // --- TIMING (In Ticks) ---
  timelineDuration: number; // Visible duration on timeline
  croppedSourceDuration: number; // The true distance from start to end frame in source ticks (excluding speed effects)
  offset: number; // "Trim start": how many ticks into the asset we start playing (Source Time)

  // --- META ---
  transformations: ClipTransform[];
}

export interface TimelineClipBase extends BaseClip {
  trackId: string;
  start: number; // Global timeline start position
}

export interface StandardTimelineClip extends TimelineClipBase {
  type: Exclude<ClipType, "mask">;
  textData?: TextClipData;
  /** Per-clip audio mute. When true, the audio renderer bypasses this clip. */
  isMuted?: boolean;
  /**
   * Typed attachments carried with this clip. Variants include:
   *  - `mask_ref`: reference to a subordinate MaskTimelineClip
   *  - `mask_composition`: boolean expression, algebra, and edge transforms
   *  - `range_mask`: source-time window of transparency
   */
  components?: Component[];
}

export interface TextTimelineClip extends StandardTimelineClip {
  type: "text";
  textData: TextClipData;
}

export interface MaskTimelineClip extends TimelineClipBase {
  type: "mask";
  parentClipId?: string;
  maskType: ClipMaskType;
  maskMode: ClipMaskMode;
  maskInverted: boolean;
  /** Optional per-mask growth applied to SAM2 masks before composition. */
  sam2GrowAmount?: number;
  maskParameters: ClipMaskParameters;
  /** Optional point prompts for SAM2 masks. */
  maskPoints?: ClipMaskPoint[];
  /** Linked generated mask asset for SAM2 runtime masking. */
  sam2MaskAssetId?: string;
  /** Hash of points used for last generated SAM2 mask asset. */
  sam2GeneratedPointsHash?: string;
  /** Epoch ms of the last successful SAM2 generation. */
  sam2LastGeneratedAt?: number;
  /** Linked mask asset from generation pipeline. */
  generationMaskAssetId?: string;
  /** Linked PNG asset for brush masks (red-on-black bitmap). */
  brushMaskAssetId?: string;
  /**
   * Painted region bounds (brush-canvas coords) for brush masks. Persisted
   * alongside the PNG so reloads can restore the gizmo extent.
   */
  brushPaintedBounds?: BrushPaintedBounds;
  /**
   * When set, the mask is only active inside this source-time window
   * (parent-clip source ticks). Outside the window the mask is treated as a
   * no-op, similar to a SAM2 mask before its asset has been generated.
   */
  activeRange?: MaskActiveRange;
}

export type TimelineClip = StandardTimelineClip | MaskTimelineClip;

export interface TimelineTrack {
  id: string;
  type?: TrackType;
  label: string;
  isVisible: boolean;
  isMuted: boolean;
  isLocked: boolean;
}
