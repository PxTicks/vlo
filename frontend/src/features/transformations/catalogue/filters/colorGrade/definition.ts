import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  DEFAULT_COLOR_CURVES,
  V1_AUTHORED_COLOR_MODEL,
} from "../../../../../core/color";
import {
  COLOR_WHEELS_CONTROL_ID,
  HUE_CURVES_CONTROL_ID,
  VALUE_CURVES_CONTROL_ID,
} from "../../../../colorGrading/constants";
import { filterHandler } from "../../filterHandler";
import type { TransformationDefinition } from "../../types";
import type { ControlDefinition } from "../../../../panelUI";
import { ColorGradeFilter } from "./colorGradeFilter";

export const COLOR_GRADE_FILTER_NAME = "ColorGradeFilter";

const WHEEL_NAMES = ["lift", "gamma", "gain", "offset"] as const;
const WHEEL_CONTROLS: readonly ControlDefinition[] = WHEEL_NAMES.flatMap(
  (wheel) =>
    (["R", "G", "B", "Master"] as const).map((channel) => ({
      type: "number" as const,
      label: `${wheel} ${channel}`,
      name: `${wheel}${channel}`,
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      supportsSpline: true,
      hidden: true,
    })),
);

export const colorGradeDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  adjustmentCompatible: true,
  filterName: COLOR_GRADE_FILTER_NAME,
  FilterClass: ColorGradeFilter,
  label: "Color Grade",
  handler: filterHandler,
  defaultParameters: {
    colorModel: V1_AUTHORED_COLOR_MODEL,
    kneeThreshold: DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold,
    kneeSoftness: DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness,
    toeAmount: DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount,
    toeSoftness: DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness,
    ditherStrength: 1,
    ...DEFAULT_COLOR_CURVES,
  },
  uiConfig: {
    groups: [
      {
        id: "color_grade_light",
        title: "Light",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Exposure",
            name: "exposure",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.exposure,
            min: -8,
            max: 8,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Temperature",
            name: "temperature",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.temperature,
            min: -100,
            max: 100,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Tint",
            name: "tint",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.tint,
            min: -100,
            max: 100,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "color_grade_wheels",
        title: "Primaries",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "Color wheels",
            name: "_colorWheels",
            componentId: COLOR_WHEELS_CONTROL_ID,
          },
          ...WHEEL_CONTROLS,
        ],
      },
      {
        id: "color_grade_tone",
        title: "Tone",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Contrast",
            name: "contrast",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.contrast,
            min: 0,
            max: 2,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Knee threshold",
            name: "kneeThreshold",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold,
            min: 0.5,
            max: 1.5,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Knee softness",
            name: "kneeSoftness",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness,
            min: 0,
            max: 0.5,
            step: 0.005,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Toe amount",
            name: "toeAmount",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Toe softness",
            name: "toeSoftness",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness,
            min: 0,
            max: 0.5,
            step: 0.005,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Pivot",
            name: "pivot",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.pivot,
            min: 0,
            max: 1,
            step: 0.005,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "color_grade_curves",
        title: "Curves",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "Value curves",
            name: "_valueCurves",
            componentId: VALUE_CURVES_CONTROL_ID,
            config: { kind: "value" },
          },
          {
            type: "custom",
            label: "Hue and saturation curves",
            name: "_hueCurves",
            componentId: HUE_CURVES_CONTROL_ID,
            config: { kind: "hue" },
          },
        ],
      },
      {
        id: "color_grade_color",
        title: "Color",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Saturation",
            name: "saturation",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.saturation,
            min: 0,
            max: 2,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Vibrance",
            name: "vibrance",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.vibrance,
            min: -1,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Hue",
            name: "hueRotate",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate,
            min: -180,
            max: 180,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
