import type { ClipTransform } from "../../types/TimelineTypes";
import type {
  ExtensionKeyframedScalarParameter,
  ExtensionScalarSourceParameter,
  ExtensionSpatialPathParameter,
} from "../extensions/types";
import type { Point2D } from "./utils/catmullRomUtils";

export type TransformType = "position" | "scale" | "rotation" | "speed" | "volume";

export interface SplinePoint {
  time: number;
  value: number;
}

export interface SplineParameter {
  type: "spline";
  points: SplinePoint[];
}

export interface PositionPathParameter {
  type: "path2d";
  curve: "centripetal_catmull_rom";
  controlPoints: Point2D[];
  timing: SplineParameter;
}

export type SpatialPathParameter =
  | PositionPathParameter
  | ExtensionSpatialPathParameter;

export function isSplineParameter(val: unknown): val is SplineParameter {
  return (
    typeof val === "object" &&
    val !== null &&
    "type" in val &&
    (val as SplineParameter).type === "spline"
  );
}

export function isExtensionScalarSourceParameter(
  value: unknown,
): value is ExtensionScalarSourceParameter {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "extension-scalar" &&
    "source" in value
  );
}

export function isExtensionKeyframedScalarParameter(
  value: unknown,
): value is ExtensionKeyframedScalarParameter {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "extension-keyframed-scalar" &&
    "keyframes" in value &&
    Array.isArray(value.keyframes)
  );
}

export function isExtensionSpatialPathParameter(
  value: unknown,
): value is ExtensionSpatialPathParameter {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "extension-path2d" &&
    "geometry" in value &&
    "timing" in value
  );
}

export type ScalarParameter =
  | number
  | SplineParameter
  | ExtensionScalarSourceParameter
  | ExtensionKeyframedScalarParameter;

export interface PositionParams {
  x: ScalarParameter;
  y: ScalarParameter;
  path?: PositionPathParameter;
  /** Extension-owned geometry is separate so legacy path editing stays typed. */
  extensionPath?: ExtensionSpatialPathParameter;
  [key: string]: unknown;
}

export interface ScaleParams {
  x: ScalarParameter;
  y: ScalarParameter;
  [key: string]: unknown;
}

export interface RotationParams {
  angle: ScalarParameter; // Radians
  [key: string]: unknown;
}

// Helper types to strictly type the generic ClipTransform when we know the type
export interface PositionTransform extends ClipTransform {
  type: "position";
  parameters: PositionParams;
}

export interface ScaleTransform extends ClipTransform {
  type: "scale";
  parameters: ScaleParams;
}

export interface RotationTransform extends ClipTransform {
  type: "rotation";
  parameters: RotationParams;
}

export interface SpeedParams {
  factor: ScalarParameter;
  [key: string]: unknown;
}

export interface SpeedTransform extends ClipTransform {
  type: "speed";
  parameters: SpeedParams;
}

export interface VolumeParams {
  gain: ScalarParameter;
  [key: string]: unknown;
}

export interface VolumeTransform extends ClipTransform {
  type: "volume";
  parameters: VolumeParams;
}

export interface GenericFilterTransform extends ClipTransform {
  type: "filter";
  filterName: string;
  parameters: Record<string, unknown>;
}

// --- Audio effect transforms ---
// Like `volume`, these have a no-op visual handler; their behavior lives in the
// audio renderer (see renderer/services/audioEffectChain.ts), which maps them
// to a chain of Web Audio nodes inserted after the per-clip gain node.
export const AUDIO_EFFECT_TYPES = [
  "pan",
  "audioEq",
  "compressor",
  "reverb",
  "delay",
] as const;

export type AudioEffectType = (typeof AUDIO_EFFECT_TYPES)[number];

export function isAudioEffectType(type: string): type is AudioEffectType {
  return (AUDIO_EFFECT_TYPES as readonly string[]).includes(type);
}

export interface PanParams {
  pan: ScalarParameter; // -1 (full left) .. 1 (full right)
  [key: string]: unknown;
}

export interface PanTransform extends ClipTransform {
  type: "pan";
  parameters: PanParams;
}

export interface EqParams {
  lowGain: ScalarParameter; // dB
  lowFreq: ScalarParameter; // Hz, low shelf
  midGain: ScalarParameter; // dB
  midFreq: ScalarParameter; // Hz, peaking center
  highGain: ScalarParameter; // dB
  highFreq: ScalarParameter; // Hz, high shelf
  [key: string]: unknown;
}

export interface EqTransform extends ClipTransform {
  type: "audioEq";
  parameters: EqParams;
}

export interface CompressorParams {
  threshold: ScalarParameter; // dB
  ratio: ScalarParameter;
  attack: ScalarParameter; // seconds
  release: ScalarParameter; // seconds
  knee: ScalarParameter; // dB
  makeup: ScalarParameter; // linear gain multiplier
  [key: string]: unknown;
}

export interface CompressorTransform extends ClipTransform {
  type: "compressor";
  parameters: CompressorParams;
}

export interface ReverbParams {
  mix: ScalarParameter; // 0 (dry) .. 1 (wet)
  decay: ScalarParameter; // seconds (impulse-response tail length)
  [key: string]: unknown;
}

export interface ReverbTransform extends ClipTransform {
  type: "reverb";
  parameters: ReverbParams;
}

export interface DelayParams {
  time: ScalarParameter; // seconds
  feedback: ScalarParameter; // 0 .. <1
  mix: ScalarParameter; // 0 (dry) .. 1 (wet)
  [key: string]: unknown;
}

export interface DelayTransform extends ClipTransform {
  type: "delay";
  parameters: DelayParams;
}

export type AudioEffectTransform =
  | PanTransform
  | EqTransform
  | CompressorTransform
  | ReverbTransform
  | DelayTransform;

export type AnyTransform =
  | PositionTransform
  | ScaleTransform
  | RotationTransform
  | SpeedTransform
  | VolumeTransform
  | AudioEffectTransform
  | GenericFilterTransform;
