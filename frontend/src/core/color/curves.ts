export interface ColorCurvePoint {
  readonly x: number;
  readonly y: number;
}

export const VALUE_CURVE_PARAMETER_NAMES = [
  "curveMaster",
  "curveR",
  "curveG",
  "curveB",
] as const;

export const PERIODIC_CURVE_PARAMETER_NAMES = [
  "curveHueHue",
  "curveHueSat",
  "curveLumaSat",
] as const;

export type ValueCurveParameterName =
  (typeof VALUE_CURVE_PARAMETER_NAMES)[number];
export type PeriodicCurveParameterName =
  (typeof PERIODIC_CURVE_PARAMETER_NAMES)[number];
export type ColorCurveParameterName =
  | ValueCurveParameterName
  | PeriodicCurveParameterName;

const IDENTITY_CURVE = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
]);
const FLAT_PERIODIC_CURVE = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 0.5, y: 0 }),
]);

export const DEFAULT_COLOR_CURVES: Readonly<
  Record<ColorCurveParameterName, readonly ColorCurvePoint[]>
> = Object.freeze({
  curveMaster: IDENTITY_CURVE,
  curveR: IDENTITY_CURVE,
  curveG: IDENTITY_CURVE,
  curveB: IDENTITY_CURVE,
  curveHueHue: FLAT_PERIODIC_CURVE,
  curveHueSat: FLAT_PERIODIC_CURVE,
  curveLumaSat: FLAT_PERIODIC_CURVE,
});
