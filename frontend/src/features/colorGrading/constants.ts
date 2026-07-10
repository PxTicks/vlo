export const COLOR_WHEELS_CONTROL_ID = "color-grading.wheels";
export const VALUE_CURVES_CONTROL_ID = "color-grading.value-curves";
export const HUE_CURVES_CONTROL_ID = "color-grading.hue-curves";

export const COLOR_WHEEL_NAMES = ["lift", "gamma", "gain", "offset"] as const;
export type ColorWheelName = (typeof COLOR_WHEEL_NAMES)[number];

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
