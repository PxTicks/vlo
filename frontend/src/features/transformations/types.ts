import type { ClipTransform } from "../../types/TimelineTypes";
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

export function isSplineParameter(val: unknown): val is SplineParameter {
  return (
    typeof val === "object" &&
    val !== null &&
    "type" in val &&
    (val as SplineParameter).type === "spline"
  );
}

export type ScalarParameter = number | SplineParameter;

export interface PositionParams {
  x: ScalarParameter;
  y: ScalarParameter;
  path?: PositionPathParameter;
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

export type AnyTransform =
  | PositionTransform
  | ScaleTransform
  | RotationTransform
  | SpeedTransform
  | VolumeTransform
  | GenericFilterTransform;
