import type { ExtensionModule } from "@vlo/extension-sdk";
import {
  createMatrixRainFilter,
  DEFAULT_MATRIX_RAIN_PARAMETERS,
  MATRIX_RAIN_CONTROL_GROUPS,
  MATRIX_RAIN_RENDERING,
  MATRIX_RAIN_TRANSFORM_ID,
  validateMatrixRainAuthoredParameters,
} from "./features/matrixRain";

/**
 * Source-aware Matrix Rain — advanced trusted-filter fixture.
 *
 * Phase 0 registers the primary `matrix-rain` transformation through the
 * ordinary `trusted-filter` contribution lane: no Matrix-specific host loader,
 * registry, or built-in filter. The persisted identity becomes
 * `example.matrix-rain/matrix-rain`, registration is owner-scoped and rolls back
 * on failure, and the filter renders through the normal live/adjustment/export
 * transformation stack. The baseline filter is a single-pass passthrough/debug
 * shader; the declared history rendering metadata reserves the temporal
 * contract that later phases implement.
 */
export const activate: ExtensionModule["activate"] = (context) => {
  context.api.transformations.register({
    id: MATRIX_RAIN_TRANSFORM_ID,
    apiVersion: 1,
    kind: "trusted-filter",
    label: "Matrix Rain",
    adjustmentCompatible: true,
    rendering: MATRIX_RAIN_RENDERING,
    groups: MATRIX_RAIN_CONTROL_GROUPS,
    defaultParameters: DEFAULT_MATRIX_RAIN_PARAMETERS,
    validateParameters: validateMatrixRainAuthoredParameters,
    createFilter: () => createMatrixRainFilter(context.api.runtime.pixi),
  });
};
