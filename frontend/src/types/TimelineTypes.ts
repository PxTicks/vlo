import type { ClipComponentBase } from "./ClipComponents";

export type TrackType = "visual" | "audio" | "prompt" | "effects" | "mask";

export type ClipType = "video" | "image" | "audio" | "text" | "shape" | "mask";

export interface TimelineSelection {
  start: number;
  end?: number;
  clips: TimelineClip[];
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

export type ClipMaskType = "circle" | "rectangle" | "triangle" | "sam2" | "generation";
export type ClipMaskMode = "apply" | "preview" | "off";

export interface ClipMaskParameters {
  baseWidth: number;
  baseHeight: number;
}

export interface ClipMaskPoint {
  x: number; // normalized [0, 1] relative to clip width
  y: number; // normalized [0, 1] relative to clip height
  label: 0 | 1; // 1 = positive/include, 0 = negative/exclude
  /** Clip-relative input/source time (ticks), transformation-faithful. */
  timeTicks: number;
}

export interface ClipMask extends ClipComponentBase<ClipMaskParameters> {
  type: ClipMaskType;
  mode: ClipMaskMode;
  inverted: boolean;
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

export type TimelineClipComponentType = "mask";

export interface TimelineClipComponentRef {
  clipId: string;
  componentType: TimelineClipComponentType;
}

export interface StandardTimelineClip extends TimelineClipBase {
  type: Exclude<ClipType, "mask">;
  /**
   * Clip components (masks, motion encodings, etc.) owned by this clip.
   * Each component points to a subordinate clip and declares its component type.
   */
  clipComponents?: TimelineClipComponentRef[];
}

export interface MaskTimelineClip extends TimelineClipBase {
  type: "mask";
  parentClipId?: string;
  maskType: ClipMaskType;
  maskMode: ClipMaskMode;
  maskInverted: boolean;
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
