import { MATRIX_RAIN_BOUNDS } from "../constants";
import type { MatrixRainParameters } from "../types";

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const EXPECTED_KEYS: ReadonlySet<string> = new Set([
  "size",
  "seed",
  "debugTint",
  "backgroundColor",
]);

function isInBounds(
  value: unknown,
  bounds: { min: number; max: number },
  integer: boolean,
): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max &&
    (!integer || Number.isInteger(value))
  );
}

/**
 * A host-supported animated scalar the panel persists when a continuous control
 * opts into splines. The registration's native control bounds already validate
 * the envelope and every point; the authored validator must preserve it rather
 * than demand a plain number, so animated debug-tint survives round-tripping.
 */
function isSupportedScalarObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "spline"
  );
}

/**
 * Custom authored-parameter validator. It enforces the exact key set,
 * static-field types, integer fields, color format, and continuous-field
 * ranges, while accepting host-supported scalar animation objects for the
 * spline-enabled `debugTint`. It never clamps — persisted invalid data fails
 * closed instead of being silently rewritten during rendering.
 */
export function validateMatrixRainAuthoredParameters(
  parameters: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(parameters);
  if (keys.length !== EXPECTED_KEYS.size) return false;
  for (const key of keys) {
    if (!EXPECTED_KEYS.has(key)) return false;
  }

  if (!isInBounds(parameters.size, MATRIX_RAIN_BOUNDS.size, true)) return false;
  if (!isInBounds(parameters.seed, MATRIX_RAIN_BOUNDS.seed, true)) return false;

  const debugTint = parameters.debugTint;
  if (
    !isInBounds(debugTint, MATRIX_RAIN_BOUNDS.debugTint, false) &&
    !isSupportedScalarObject(debugTint)
  ) {
    return false;
  }

  return (
    typeof parameters.backgroundColor === "string" &&
    COLOR_PATTERN.test(parameters.backgroundColor)
  );
}

/**
 * Fail-closed narrowing used by `update()`. The host resolves animated scalars
 * to numbers before dispatch, so every numeric field must be finite and in
 * range here; a non-finite value returns `null` rather than reaching a GPU
 * uniform.
 */
export function resolveMatrixRainParameters(
  parameters: Readonly<Record<string, unknown>>,
): MatrixRainParameters | null {
  if (
    !isInBounds(parameters.size, MATRIX_RAIN_BOUNDS.size, true) ||
    !isInBounds(parameters.seed, MATRIX_RAIN_BOUNDS.seed, true) ||
    !isInBounds(parameters.debugTint, MATRIX_RAIN_BOUNDS.debugTint, false) ||
    typeof parameters.backgroundColor !== "string" ||
    !COLOR_PATTERN.test(parameters.backgroundColor)
  ) {
    return null;
  }
  return {
    size: parameters.size as number,
    seed: parameters.seed as number,
    debugTint: parameters.debugTint as number,
    backgroundColor: parameters.backgroundColor,
  };
}

/** Convert a #RRGGBB string to a normalized [r, g, b] vector for uniforms. */
export function colorToVec3(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}
