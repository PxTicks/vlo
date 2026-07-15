import type {
  ExtensionTransformationControlGroup,
  ExtensionTrustedFilterRenderingDefinition,
} from "@vlo/extension-sdk";
import type { MatrixRainParameters } from "./types";

/** Owner-local transform ID; the host qualifies it to `example.matrix-rain/matrix-rain`. */
export const MATRIX_RAIN_TRANSFORM_ID = "matrix-rain";

/**
 * Render-dependency policy. Matrix Rain is a history-dependent temporal filter:
 * it declares a bounded replay window and the largest continuous step it
 * accepts before the host must subdivide or warm up. Phase 0 does not yet run
 * feedback, but declaring the policy now exercises the host's rendering-metadata
 * validation and keeps the persisted contract stable across the later phases.
 */
export const MATRIX_RAIN_RENDERING: ExtensionTrustedFilterRenderingDefinition = {
  timeDependency: "history",
  maxHistorySeconds: 6,
  maxStepSeconds: 1 / 30,
};

// `satisfies` (not an annotation) keeps the anonymous literal type so the
// defaults stay assignable to the host's `Record<string, JsonValue>` parameter
// bag while still being checked against the resolved parameter shape.
export const DEFAULT_MATRIX_RAIN_PARAMETERS = {
  size: 10,
  seed: 1,
  debugTint: 1,
  backgroundColor: "#001a00",
} satisfies MatrixRainParameters;

/**
 * Phase 0 control surface. Grouped by the plan's taxonomy (`grid`, `debug`);
 * later phases add the `source`, `feedback`, `brightness`, `palette`, and
 * `composition` groups. `size` and `seed` are static (topology/seed); the debug
 * tint is a continuous aesthetic control and opts into spline animation.
 */
export const MATRIX_RAIN_CONTROL_GROUPS: readonly ExtensionTransformationControlGroup[] =
  [
    {
      id: "grid",
      title: "Grid",
      controls: [
        {
          type: "slider",
          name: "size",
          label: "Cell Size",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.size,
          min: 4,
          max: 32,
          step: 1,
        },
        {
          type: "number",
          name: "seed",
          label: "Seed",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.seed,
          min: 0,
          max: 16_777_215,
          step: 1,
        },
      ],
    },
    {
      id: "debug",
      title: "Debug",
      controls: [
        {
          type: "slider",
          name: "debugTint",
          label: "Debug Tint",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.debugTint,
          min: 0,
          max: 1,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "color",
          name: "backgroundColor",
          label: "Background",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.backgroundColor,
        },
      ],
    },
  ];

/** Integer authoring bounds enforced by the custom validator. */
export const MATRIX_RAIN_BOUNDS = {
  size: { min: 4, max: 32 },
  seed: { min: 0, max: 16_777_215 },
  debugTint: { min: 0, max: 1 },
} as const;
