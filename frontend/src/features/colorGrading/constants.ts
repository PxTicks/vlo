import type { ControlDefinition } from "../panelUI";

export const COLOR_WHEELS_CONTROL_ID = "color-grading.wheels";
export const VALUE_CURVES_CONTROL_ID = "color-grading.value-curves";
export const HUE_CURVES_CONTROL_ID = "color-grading.hue-curves";

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
