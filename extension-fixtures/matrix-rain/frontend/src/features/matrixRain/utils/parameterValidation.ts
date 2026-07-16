import {
  ACCUMULATION_MODES,
  DEBUG_MODES,
  MATRIX_RAIN_COLOR_KEYS,
  MATRIX_RAIN_NUMERIC_BOUNDS,
  MATRIX_RAIN_SPLINE_KEYS,
  MOTION_MODES,
  OUTPUT_MODES,
  SIGNAL_MODES,
} from "../constants";
import type {
  MatrixAccumulationMode,
  MatrixDebugMode,
  MatrixMotionMode,
  MatrixOutputMode,
  MatrixRainParameters,
  MatrixSignalMode,
} from "../types";

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type NumericKey = keyof typeof MATRIX_RAIN_NUMERIC_BOUNDS;
const NUMERIC_KEYS = Object.keys(MATRIX_RAIN_NUMERIC_BOUNDS) as NumericKey[];

const EXPECTED_KEYS: ReadonlySet<string> = new Set<string>([
  ...NUMERIC_KEYS,
  ...MATRIX_RAIN_COLOR_KEYS,
  "signalMode",
  "motionMode",
  "accumulationMode",
  "outputMode",
  "debugMode",
]);

function isNumberInBounds(value: unknown, key: NumericKey): boolean {
  const bounds = MATRIX_RAIN_NUMERIC_BOUNDS[key];
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max &&
    (!bounds.integer || Number.isInteger(value))
  );
}

/**
 * A host-supported animated scalar the panel persists when a continuous control
 * opts into splines. The native control bounds already validate the envelope
 * and every point; the authored validator must preserve it rather than demand a
 * plain number so animated fields survive round-tripping.
 */
function isSupportedScalarObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "spline"
  );
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

function isOutputMode(value: unknown): value is MatrixOutputMode {
  return typeof value === "string" && OUTPUT_MODES.includes(value as MatrixOutputMode);
}

function isDebugMode(value: unknown): value is MatrixDebugMode {
  return typeof value === "string" && DEBUG_MODES.includes(value as MatrixDebugMode);
}

function isSignalMode(value: unknown): value is MatrixSignalMode {
  return typeof value === "string" && SIGNAL_MODES.includes(value as MatrixSignalMode);
}

function isMotionMode(value: unknown): value is MatrixMotionMode {
  return typeof value === "string" && MOTION_MODES.includes(value as MatrixMotionMode);
}

function isAccumulationMode(value: unknown): value is MatrixAccumulationMode {
  return (
    typeof value === "string" &&
    ACCUMULATION_MODES.includes(value as MatrixAccumulationMode)
  );
}

/**
 * Custom authored-parameter validator. It enforces the exact key set, numeric
 * bounds and integer fields, color formats, and enum membership, while
 * accepting host-supported scalar animation objects for spline-enabled fields.
 * It never clamps — persisted invalid data fails closed instead of being
 * silently rewritten during rendering.
 */
export function validateMatrixRainAuthoredParameters(
  parameters: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(parameters);
  if (keys.length !== EXPECTED_KEYS.size) return false;
  for (const key of keys) {
    if (!EXPECTED_KEYS.has(key)) return false;
  }

  for (const key of NUMERIC_KEYS) {
    const value = parameters[key];
    if (isNumberInBounds(value, key)) continue;
    if (MATRIX_RAIN_SPLINE_KEYS.has(key) && isSupportedScalarObject(value)) {
      continue;
    }
    return false;
  }

  for (const key of MATRIX_RAIN_COLOR_KEYS) {
    if (!isColor(parameters[key])) return false;
  }

  return (
    isSignalMode(parameters.signalMode) &&
    isMotionMode(parameters.motionMode) &&
    isAccumulationMode(parameters.accumulationMode) &&
    isOutputMode(parameters.outputMode) &&
    isDebugMode(parameters.debugMode)
  );
}

/**
 * Fail-closed narrowing used by `update()`. The host resolves animated scalars
 * to numbers before dispatch, so every numeric field must be finite and in
 * range here; anything invalid returns `null` rather than reaching a GPU
 * uniform.
 */
export function resolveMatrixRainParameters(
  parameters: Readonly<Record<string, unknown>>,
): MatrixRainParameters | null {
  for (const key of NUMERIC_KEYS) {
    if (!isNumberInBounds(parameters[key], key)) return null;
  }
  for (const key of MATRIX_RAIN_COLOR_KEYS) {
    if (!isColor(parameters[key])) return null;
  }
  if (!isSignalMode(parameters.signalMode)) return null;
  if (!isMotionMode(parameters.motionMode)) return null;
  if (!isAccumulationMode(parameters.accumulationMode)) return null;
  if (!isOutputMode(parameters.outputMode)) return null;
  if (!isDebugMode(parameters.debugMode)) return null;

  return {
    size: parameters.size as number,
    verticalSpacing: parameters.verticalSpacing as number,
    seed: parameters.seed as number,
    glyphCycleRate: parameters.glyphCycleRate as number,
    fallSpeed: parameters.fallSpeed as number,
    speedVariation: parameters.speedVariation as number,
    trailShape: parameters.trailShape as number,
    pulseDensity: parameters.pulseDensity as number,
    headWidth: parameters.headWidth as number,
    signalMode: parameters.signalMode as MatrixSignalMode,
    lumaWeight: parameters.lumaWeight as number,
    edgeWeight: parameters.edgeWeight as number,
    edgeGain: parameters.edgeGain as number,
    alphaEdgeWeight: parameters.alphaEdgeWeight as number,
    signalThreshold: parameters.signalThreshold as number,
    signalGain: parameters.signalGain as number,
    signalGamma: parameters.signalGamma as number,
    trailHalfLife: parameters.trailHalfLife as number,
    baseInjection: parameters.baseInjection as number,
    ambientSpawn: parameters.ambientSpawn as number,
    sourceInfluence: parameters.sourceInfluence as number,
    motionInfluence: parameters.motionInfluence as number,
    motionMode: parameters.motionMode as MatrixMotionMode,
    motionThreshold: parameters.motionThreshold as number,
    motionGain: parameters.motionGain as number,
    motionImmediateAmount: parameters.motionImmediateAmount as number,
    injectionStrength: parameters.injectionStrength as number,
    darkDamping: parameters.darkDamping as number,
    accumulationMode: parameters.accumulationMode as MatrixAccumulationMode,
    directShapeStrength: parameters.directShapeStrength as number,
    directMotionStrength: parameters.directMotionStrength as number,
    rainStrength: parameters.rainStrength as number,
    headIntensity: parameters.headIntensity as number,
    sourceHeadInfluence: parameters.sourceHeadInfluence as number,
    motionHeadInfluence: parameters.motionHeadInfluence as number,
    ditherMagnitude: parameters.ditherMagnitude as number,
    backgroundColor: parameters.backgroundColor as string,
    shadowColor: parameters.shadowColor as string,
    bodyColor: parameters.bodyColor as string,
    brightColor: parameters.brightColor as string,
    headColor: parameters.headColor as string,
    outputMode: parameters.outputMode as MatrixOutputMode,
    debugMode: parameters.debugMode as MatrixDebugMode,
  };
}

export function outputModeIndex(mode: MatrixOutputMode): number {
  return Math.max(0, OUTPUT_MODES.indexOf(mode));
}

export function debugModeIndex(mode: MatrixDebugMode): number {
  return Math.max(0, DEBUG_MODES.indexOf(mode));
}

export function signalModeIndex(mode: MatrixSignalMode): number {
  return Math.max(0, SIGNAL_MODES.indexOf(mode));
}

export function motionModeIndex(mode: MatrixMotionMode): number {
  return Math.max(0, MOTION_MODES.indexOf(mode));
}

export function accumulationModeIndex(mode: MatrixAccumulationMode): number {
  return Math.max(0, ACCUMULATION_MODES.indexOf(mode));
}
