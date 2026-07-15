import type {
  ExtensionTransformationControlGroup,
  ExtensionTrustedFilterRenderingDefinition,
} from "@vlo/extension-sdk";
import type {
  MatrixDebugMode,
  MatrixOutputMode,
  MatrixRainParameters,
} from "./types";

/** Owner-local transform ID; the host qualifies it to `example.matrix-rain/matrix-rain`. */
export const MATRIX_RAIN_TRANSFORM_ID = "matrix-rain";

/**
 * Render-dependency policy. Phase 3 retains per-cell feedback state across
 * frames (a decaying, advecting rain trail), so the effect now genuinely
 * depends on earlier samples and declares `history` with a bounded replay
 * window. `maxStepSeconds` caps the continuous step the state update accepts
 * before the host must subdivide or warm up. Rendering metadata is authoring
 * policy and is not persisted per transform.
 */
export const MATRIX_RAIN_RENDERING: ExtensionTrustedFilterRenderingDefinition = {
  timeDependency: "history",
  maxHistorySeconds: 6,
  maxStepSeconds: 1 / 30,
};

/**
 * Output/debug enum orderings. Their array index is the integer value sent to
 * the shader `uOutputMode` / `uDebugMode` uniforms, so order is part of the
 * GPU contract and must match the shader `switch`/`if` ladders.
 */
export const OUTPUT_MODES: readonly MatrixOutputMode[] = [
  "replaceBlack",
  "matrixOnly",
];

export const DEBUG_MODES: readonly MatrixDebugMode[] = [
  "none",
  "cellGrid",
  "proceduralTrail",
  "proceduralHead",
  "rainState",
  "advectedPrevious",
];

// `satisfies` (not an annotation) keeps the anonymous literal type so the
// defaults stay assignable to the host's `Record<string, JsonValue>` parameter
// bag while still being checked against the resolved parameter shape.
export const DEFAULT_MATRIX_RAIN_PARAMETERS = {
  size: 10,
  verticalSpacing: 2,
  seed: 1,
  glyphCycleRate: 3,
  fallSpeed: 8,
  speedVariation: 0.35,
  trailShape: 1.8,
  pulseDensity: 0.7,
  headWidth: 0.1,
  trailHalfLife: 0.45,
  baseInjection: 0.04,
  sourceInfluence: 0.85,
  directShapeStrength: 0.25,
  rainStrength: 1,
  headIntensity: 1.5,
  ditherMagnitude: 0.015,
  backgroundColor: "#000000",
  shadowColor: "#003b00",
  bodyColor: "#00c21f",
  brightColor: "#7dff97",
  headColor: "#d6ffe4",
  outputMode: "replaceBlack",
  debugMode: "none",
} satisfies MatrixRainParameters;

/**
 * Phase 2 control surface, grouped by the plan's taxonomy. `size`, `seed`,
 * enums, and colors are static; continuous aesthetic controls opt into spline
 * animation so they can be keyframed by the host.
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
          label: "Glyph Size",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.size,
          min: 4,
          max: 128,
          step: 1,
        },
        {
          type: "slider",
          name: "verticalSpacing",
          label: "Vertical Spacing",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.verticalSpacing,
          min: 0,
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
        {
          type: "slider",
          name: "glyphCycleRate",
          label: "Glyph Cycle Rate",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.glyphCycleRate,
          min: 0,
          max: 15,
          step: 0.1,
          supportsSpline: true,
        },
      ],
    },
    {
      id: "motion",
      title: "Motion",
      controls: [
        {
          type: "slider",
          name: "fallSpeed",
          label: "Fall Speed",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.fallSpeed,
          min: 0,
          max: 30,
          step: 0.1,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "speedVariation",
          label: "Speed Variation",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.speedVariation,
          min: 0,
          max: 1,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "trailShape",
          label: "Trail Shape",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.trailShape,
          min: 0.25,
          max: 5,
          step: 0.05,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "pulseDensity",
          label: "Pulse Density",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.pulseDensity,
          min: 0.05,
          max: 2,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "headWidth",
          label: "Head Width",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.headWidth,
          min: 0.01,
          max: 0.5,
          step: 0.01,
          supportsSpline: true,
        },
      ],
    },
    {
      id: "feedback",
      title: "Feedback",
      controls: [
        {
          type: "slider",
          name: "trailHalfLife",
          label: "Trail Half-life",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.trailHalfLife,
          min: 0.05,
          max: 2,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "baseInjection",
          label: "Base Injection",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.baseInjection,
          min: 0,
          max: 1,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "sourceInfluence",
          label: "Source Influence",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.sourceInfluence,
          min: 0,
          max: 2,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "directShapeStrength",
          label: "Direct Shape",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.directShapeStrength,
          min: 0,
          max: 2,
          step: 0.01,
          supportsSpline: true,
        },
      ],
    },
    {
      id: "brightness",
      title: "Brightness",
      controls: [
        {
          type: "slider",
          name: "rainStrength",
          label: "Rain Strength",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.rainStrength,
          min: 0,
          max: 3,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "headIntensity",
          label: "Head Intensity",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.headIntensity,
          min: 0,
          max: 4,
          step: 0.01,
          supportsSpline: true,
        },
        {
          type: "slider",
          name: "ditherMagnitude",
          label: "Dither",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.ditherMagnitude,
          min: 0,
          max: 0.05,
          step: 0.001,
          supportsSpline: true,
        },
      ],
    },
    {
      id: "palette",
      title: "Palette",
      columns: 2,
      controls: [
        {
          type: "color",
          name: "backgroundColor",
          label: "Background",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.backgroundColor,
        },
        {
          type: "color",
          name: "shadowColor",
          label: "Shadow",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.shadowColor,
        },
        {
          type: "color",
          name: "bodyColor",
          label: "Body",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.bodyColor,
        },
        {
          type: "color",
          name: "brightColor",
          label: "Bright",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.brightColor,
        },
        {
          type: "color",
          name: "headColor",
          label: "Head",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.headColor,
        },
      ],
    },
    {
      id: "composition",
      title: "Composition",
      controls: [
        {
          type: "select",
          name: "outputMode",
          label: "Output",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.outputMode,
          options: [
            { label: "Replace (black bg)", value: "replaceBlack" },
            { label: "Matrix only (transparent)", value: "matrixOnly" },
          ],
        },
      ],
    },
    {
      id: "debug",
      title: "Debug",
      controls: [
        {
          type: "select",
          name: "debugMode",
          label: "Debug View",
          defaultValue: DEFAULT_MATRIX_RAIN_PARAMETERS.debugMode,
          options: [
            { label: "None", value: "none" },
            { label: "Cell Grid", value: "cellGrid" },
            { label: "Procedural Trail", value: "proceduralTrail" },
            { label: "Procedural Head", value: "proceduralHead" },
            { label: "Rain State", value: "rainState" },
            { label: "Advected Previous", value: "advectedPrevious" },
          ],
        },
      ],
    },
  ];

/** Numeric authoring bounds enforced by the custom validator (mirrors controls). */
export const MATRIX_RAIN_NUMERIC_BOUNDS = {
  size: { min: 4, max: 128, integer: true },
  verticalSpacing: { min: 0, max: 32, integer: true },
  seed: { min: 0, max: 16_777_215, integer: true },
  glyphCycleRate: { min: 0, max: 15, integer: false },
  fallSpeed: { min: 0, max: 30, integer: false },
  speedVariation: { min: 0, max: 1, integer: false },
  trailShape: { min: 0.25, max: 5, integer: false },
  pulseDensity: { min: 0.05, max: 2, integer: false },
  headWidth: { min: 0.01, max: 0.5, integer: false },
  trailHalfLife: { min: 0.05, max: 2, integer: false },
  baseInjection: { min: 0, max: 1, integer: false },
  sourceInfluence: { min: 0, max: 2, integer: false },
  directShapeStrength: { min: 0, max: 2, integer: false },
  rainStrength: { min: 0, max: 3, integer: false },
  headIntensity: { min: 0, max: 4, integer: false },
  ditherMagnitude: { min: 0, max: 0.05, integer: false },
} as const;

export const MATRIX_RAIN_COLOR_KEYS = [
  "backgroundColor",
  "shadowColor",
  "bodyColor",
  "brightColor",
  "headColor",
] as const;

/** Continuous numeric fields that may carry a host spline object when authored. */
export const MATRIX_RAIN_SPLINE_KEYS: ReadonlySet<string> = new Set([
  "glyphCycleRate",
  "fallSpeed",
  "speedVariation",
  "trailShape",
  "pulseDensity",
  "headWidth",
  "trailHalfLife",
  "baseInjection",
  "sourceInfluence",
  "directShapeStrength",
  "rainStrength",
  "headIntensity",
  "ditherMagnitude",
]);
