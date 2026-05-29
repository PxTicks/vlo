import type { ClipComponentBase } from "./ClipComponents";
import type { Component } from "./Components";

export type TrackType =
  | "visual"
  | "audio"
  | "prompt"
  | "effects"
  | "mask"
  | "adjustment";

export type ClipType =
  | "video"
  | "image"
  | "audio"
  | "text"
  | "shape"
  | "mask"
  | "composite"
  | "adjustment";

export type TextAlignment = "left" | "center" | "right";

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface TextClipData {
  content: string;
  runs?: TextRun[];
  fontFamily: string;
  fontSize: number;
  fill: string;
  align: TextAlignment;
  strokeColor: string;
  strokeWidth: number;
}

/**
 * The anchor-free payload describing a region of the timeline: the clips and
 * tracks that make it up plus the render-time hints (fps, frame step, track
 * filter). This is the shared core between an in-place {@link TimelineSelection}
 * (anchored at absolute timeline ticks) and a {@link CompositeContent} (whose
 * clips are normalized to local zero so the region is portable).
 */
export interface TimelineRegionData {
  clips: TimelineClip[];
  tracks?: TimelineTrack[];
  /**
   * Optional overlay filter that limits renders/extractions to an explicit set
   * of track ids while preserving the original `tracks` metadata.
   * When omitted or empty, consumers should treat the region as "all tracks".
   */
  includedTrackIds?: string[];
  /**
   * Effective FPS used for renders/extractions from this region.
   * When omitted, consumers fall back to project FPS.
   */
  fps?: number;
  /**
   * Optional frame-step constraint for AI workflows that require frame counts
   * matching `frameStep * n + 1` (for integer n). Defaults to 1.
   */
  frameStep?: number;
}

export interface TimelineSelection extends TimelineRegionData {
  start: number;
  end?: number;
  /**
   * Optional workflow-provided guidance shown while the selection is being made.
   */
  message?: string;
}

/**
 * The internal payload of a Composite clip: a self-contained timeline region
 * normalized to local zero (its clips start at tick 0, like a tiny project).
 * Mirrors {@link TimelineSelection} minus the absolute anchor — convert with
 * the adapters in `features/timelineSelection/utils/composite`.
 */
export interface CompositeContent extends TimelineRegionData {
  /** Natural length of the region in ticks (max clip end), the composite's source duration. */
  durationTicks: number;
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

export type NonMaskClipType = Exclude<ClipType, "mask">;
export type AssetBackedClipType = "video" | "image" | "audio";

export interface ClipBaseCommon {
  id: string;
  type: ClipType;
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

export interface InsertableClipBaseCommon extends ClipBaseCommon {
  type: NonMaskClipType;
}

export interface TimelineClipBaseCommon extends ClipBaseCommon {
  trackId: string;
  start: number; // Global timeline start position
}

export interface NonMaskTimelineClipCommon extends TimelineClipBaseCommon {
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

export interface AssetBackedBaseClipCommon extends InsertableClipBaseCommon {
  type: AssetBackedClipType;
  assetId: string;
}

export interface AssetBackedTimelineClipCommon
  extends NonMaskTimelineClipCommon {
  type: AssetBackedClipType;
  assetId: string;
}

export interface VideoBaseClip extends AssetBackedBaseClipCommon {
  type: "video";
}

export interface ImageBaseClip extends AssetBackedBaseClipCommon {
  type: "image";
}

export interface AudioBaseClip extends AssetBackedBaseClipCommon {
  type: "audio";
}

export interface TextBaseClip extends InsertableClipBaseCommon {
  type: "text";
  textData: TextClipData;
}

export interface ShapeBaseClip extends InsertableClipBaseCommon {
  type: "shape";
}

/**
 * A clip formed from a section of the timeline. Strategy A (prebaked proxy):
 * `content` is the editable source of truth; `proxyAssetId` points at a baked
 * video asset rendered from `content` that the renderer treats exactly like a
 * normal video clip. `proxyContentHash` records which `content` the current
 * proxy was baked from, so a live edit can detect staleness and re-bake.
 */
export interface CompositeClipExtras {
  content: CompositeContent;
  proxyAssetId?: string;
  proxyContentHash?: string;
}

export interface CompositeBaseClip
  extends InsertableClipBaseCommon,
    CompositeClipExtras {
  type: "composite";
}

export const ADJUSTMENT_DEPTH_ALL = "all";
export type AdjustmentDepth = number | typeof ADJUSTMENT_DEPTH_ALL;
export const ADJUSTMENT_RETIMING_STATIC = "static";
export const ADJUSTMENT_RETIMING_RIPPLE = "ripple";
export type AdjustmentRetimingMode =
  | typeof ADJUSTMENT_RETIMING_STATIC
  | typeof ADJUSTMENT_RETIMING_RIPPLE;

/**
 * An adjustment clip defines a render group at its position on the timeline.
 * Carries no visual content of its own; the renderer skips it. Its
 * `transformations` apply to the group container created by the orchestrator,
 * affecting every clip currently rendered through the reach below.
 */
export interface AdjustmentClipExtras {
  /**
   * Number of tracks BELOW the adjustment's own track that the group reaches,
   * or the `"all"` sentinel to keep following the bottom of the stack as
   * tracks are added and removed. Counts all track types; only visual tracks
   * among them are wrapped by the group container. Numeric depths must be ≥ 1.
   * Reach is clamped at the bottom of the track stack at derivation time.
   */
  depth: AdjustmentDepth;
  /**
   * How speed transforms on this adjustment affect timeline placement.
   * "static" pins descendant clip starts and only retimes intersecting clip
   * content; "ripple" uses the older global warp where later clips shift as
   * the affected track stretches/contracts.
   *
   * Optional for legacy project files; runtime helpers default to "static".
   */
  retimingMode?: AdjustmentRetimingMode;
}

export interface AdjustmentBaseClip
  extends Omit<InsertableClipBaseCommon, "type" | "sourceDuration">,
    AdjustmentClipExtras {
  type: "adjustment";
  sourceDuration: number;
}

export interface VideoTimelineClip extends AssetBackedTimelineClipCommon {
  type: "video";
}

export interface ImageTimelineClip extends AssetBackedTimelineClipCommon {
  type: "image";
}

export interface AudioTimelineClip extends AssetBackedTimelineClipCommon {
  type: "audio";
}

export interface TextTimelineClip extends NonMaskTimelineClipCommon {
  type: "text";
  textData: TextClipData;
}

export interface ShapeTimelineClip extends NonMaskTimelineClipCommon {
  type: "shape";
}

export interface CompositeTimelineClip
  extends NonMaskTimelineClipCommon,
    CompositeClipExtras {
  type: "composite";
}

export interface AdjustmentTimelineClip
  extends Omit<NonMaskTimelineClipCommon, "type" | "sourceDuration">,
    AdjustmentClipExtras {
  type: "adjustment";
  sourceDuration: number;
}

export interface BaseClipByType {
  video: VideoBaseClip;
  image: ImageBaseClip;
  audio: AudioBaseClip;
  text: TextBaseClip;
  shape: ShapeBaseClip;
  composite: CompositeBaseClip;
  adjustment: AdjustmentBaseClip;
}

export interface NonMaskTimelineClipByType {
  video: VideoTimelineClip;
  image: ImageTimelineClip;
  audio: AudioTimelineClip;
  text: TextTimelineClip;
  shape: ShapeTimelineClip;
  composite: CompositeTimelineClip;
  adjustment: AdjustmentTimelineClip;
}

export type AssetBackedBaseClip =
  BaseClipByType[Extract<keyof BaseClipByType, AssetBackedClipType>];
export type AssetBackedTimelineClip =
  NonMaskTimelineClipByType[
    Extract<keyof NonMaskTimelineClipByType, AssetBackedClipType>
  ];
export type NonMaskBaseClip = BaseClipByType[keyof BaseClipByType];
export type NonMaskTimelineClip =
  NonMaskTimelineClipByType[keyof NonMaskTimelineClipByType];

export interface MaskTimelineClip extends TimelineClipBaseCommon {
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

export interface TimelineClipByType extends NonMaskTimelineClipByType {
  mask: MaskTimelineClip;
}

export type BaseClip = NonMaskBaseClip;
export type StandardTimelineClip = NonMaskTimelineClip;
export type TimelineClip = TimelineClipByType[keyof TimelineClipByType];

export function isMaskClip(
  clip: BaseClip | TimelineClip | undefined | null,
): clip is MaskTimelineClip {
  return clip?.type === "mask";
}

export function isNonMaskTimelineClip(
  clip: TimelineClip | undefined | null,
): clip is NonMaskTimelineClip {
  return !!clip && clip.type !== "mask";
}

export function isAssetBackedClip(
  clip: BaseClip | TimelineClip | undefined | null,
): clip is AssetBackedBaseClip | AssetBackedTimelineClip {
  return (
    clip?.type === "video" ||
    clip?.type === "image" ||
    clip?.type === "audio"
  );
}

export function isTextClip(
  clip: BaseClip | TimelineClip | undefined | null,
): clip is TextBaseClip | TextTimelineClip {
  return clip?.type === "text";
}

export function isCompositeClip(
  clip: BaseClip | TimelineClip | undefined | null,
): clip is CompositeBaseClip | CompositeTimelineClip {
  return clip?.type === "composite";
}

export function isAdjustmentClip(
  clip: BaseClip | TimelineClip | undefined | null,
): clip is AdjustmentBaseClip | AdjustmentTimelineClip {
  return clip?.type === "adjustment";
}

export function isAdjustmentDepthAll(
  depth: AdjustmentDepth,
): depth is typeof ADJUSTMENT_DEPTH_ALL {
  return depth === ADJUSTMENT_DEPTH_ALL;
}

export function getAdjustmentRetimingMode(
  clip: AdjustmentBaseClip | AdjustmentTimelineClip,
): AdjustmentRetimingMode {
  return clip.retimingMode ?? ADJUSTMENT_RETIMING_STATIC;
}

export interface TimelineTrack {
  id: string;
  type?: TrackType;
  label: string;
  isVisible: boolean;
  isMuted: boolean;
  isLocked: boolean;
}

/**
 * A time-bounded wrapper spanning a contiguous run of visual tracks. Rendered
 * as a PixiJS Container parented between `logicalStage` and the member tracks
 * whenever the current tick falls inside the group's window.
 *
 * Two structural invariants are enforced at the command layer:
 *  1. No two groups may be simultaneously active over the same track.
 *  2. `trackIds` must form a contiguous run in the project's visual-track order.
 *
 * `transformations` is reserved for future group-level effects (adjustment
 * layers). v1 of the render-group scaffolding leaves it as an empty array.
 */
export interface TimelineGroup {
  id: string;
  label: string;
  trackIds: string[];
  start: number;
  timelineDuration: number;
  transformations: ClipTransform[];
  isVisible: boolean;
  isCollapsed?: boolean;
}

export function isGroupActiveAtTick(
  group: TimelineGroup,
  tick: number,
): boolean {
  return tick >= group.start && tick < group.start + group.timelineDuration;
}
