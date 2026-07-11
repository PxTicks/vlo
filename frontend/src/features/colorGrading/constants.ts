import type { ControlDefinition } from "../panelUI";

export const COLOR_WHEELS_CONTROL_ID = "color-grading.wheels";
export const VALUE_CURVES_CONTROL_ID = "color-grading.value-curves";
export const HUE_CURVES_CONTROL_ID = "color-grading.hue-curves";
export const TONE_SHAPING_CONTROL_ID = "color-grading.tone-shaping";
export const QUALIFIER_CONTROL_ID = "color-grading.qualifier";
export const LUT_CONTROL_ID = "color-grading.lut";
export const GRADE_MANAGEMENT_CONTROL_ID = "color-grading.management";

export const QUALIFIER_PARAMETER_CONTROLS: readonly ControlDefinition[] = [
  { type: "checkbox", label: "Enabled", name: "qualifierEnabled", defaultValue: false, hidden: true },
  { type: "number", label: "Hue centre", name: "hueCenter", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Hue width", name: "hueWidth", defaultValue: 1, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Hue low softness", name: "hueSoftLo", defaultValue: 0, min: 0, max: 0.5, step: 0.001, hidden: true },
  { type: "number", label: "Hue high softness", name: "hueSoftHi", defaultValue: 0, min: 0, max: 0.5, step: 0.001, hidden: true },
  { type: "number", label: "Saturation low", name: "satLo", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Saturation high", name: "satHi", defaultValue: 1, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Saturation low softness", name: "satSoftLo", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Saturation high softness", name: "satSoftHi", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Luma low", name: "lumaLo", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Luma high", name: "lumaHi", defaultValue: 1, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Luma low softness", name: "lumaSoftLo", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "number", label: "Luma high softness", name: "lumaSoftHi", defaultValue: 0, min: 0, max: 1, step: 0.001, hidden: true },
  { type: "checkbox", label: "Invert", name: "qualifierInvert", defaultValue: false, hidden: true },
  { type: "checkbox", label: "Matte preview", name: "mattePreview", defaultValue: false, hidden: true },
];

export const TONE_SHAPING_PARAMETER_CONTROLS: readonly ControlDefinition[] = [
  {
    type: "slider",
    label: "Highlight threshold (exact)",
    name: "kneeThreshold",
    defaultValue: 1,
    min: 0.5,
    max: 1.5,
    step: 0.01,
    supportsSpline: true,
    hidden: true,
  },
  {
    type: "slider",
    label: "Highlight transition (exact)",
    name: "kneeSoftness",
    defaultValue: 0,
    min: 0,
    max: 0.5,
    step: 0.005,
    supportsSpline: true,
    hidden: true,
  },
  {
    type: "slider",
    label: "Shadow amount (exact)",
    name: "toeAmount",
    defaultValue: 0,
    min: 0,
    max: 1,
    step: 0.01,
    supportsSpline: true,
    hidden: true,
  },
  {
    type: "slider",
    label: "Shadow transition (exact)",
    name: "toeSoftness",
    defaultValue: 0,
    min: 0,
    max: 0.5,
    step: 0.005,
    supportsSpline: true,
    hidden: true,
  },
];

export const COLOR_WHEEL_NAMES = ["lift", "gamma", "gain", "offset"] as const;
export type ColorWheelName = (typeof COLOR_WHEEL_NAMES)[number];

export const COLOR_WHEEL_PARAMETER_CONTROLS: readonly ControlDefinition[] =
  COLOR_WHEEL_NAMES.flatMap((wheel) =>
    (["R", "G", "B", "Master"] as const).map((channel) => ({
      type: "number" as const,
      label: `${wheel[0].toUpperCase()}${wheel.slice(1)} ${channel}`,
      name: `${wheel}${channel}`,
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      supportsSpline: true,
      hidden: true,
    })),
  );

export function getWheelParameterControls(
  wheel: ColorWheelName,
): readonly ControlDefinition[] {
  const parameterNames = new Set(getWheelParameterNames(wheel));
  return COLOR_WHEEL_PARAMETER_CONTROLS.filter((control) =>
    parameterNames.has(control.name),
  );
}

export function getWheelParameterNames(wheel: ColorWheelName): readonly [
  string,
  string,
  string,
  string,
] {
  return [
    `${wheel}R`,
    `${wheel}G`,
    `${wheel}B`,
    `${wheel}Master`,
  ];
}
