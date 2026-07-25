import {
  COLOR_GRADE_PARAMETER_NAMES,
  DEFAULT_COLOR_GRADE_LUT,
  DEFAULT_COLOR_GRADE_PRIMARIES,
  DEFAULT_COLOR_CURVES,
  DEFAULT_COLOR_QUALIFIER,
  V1_AUTHORED_COLOR_MODEL,
} from "../../../../../core/color";
import { EXTENSION_PANEL_CONTROL_ZONE_ID } from "../../../../extensions/ui/panelControlZoneId";
import {
  COLOR_WHEEL_PARAMETER_CONTROLS,
  COLOR_WHEELS_CONTROL_ID,
  HUE_CURVES_CONTROL_ID,
  LUT_CONTROL_ID,
  TONE_SHAPING_CONTROL_ID,
  TONE_SHAPING_PARAMETER_CONTROLS,
  VALUE_CURVES_CONTROL_ID,
  QUALIFIER_CONTROL_ID,
  GRADE_MANAGEMENT_CONTROL_ID,
} from "../../../../colorGrading/constants";
import { filterHandler } from "../../filterHandler";
import type { TransformationDefinition } from "../../types";
import { FusedColorGradeFilter } from "./fusedColorGradeFilter";

export const COLOR_GRADE_FILTER_NAME = "ColorGradeFilter";

export const colorGradeDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  adjustmentCompatible: true,
  filterName: COLOR_GRADE_FILTER_NAME,
  FilterClass: FusedColorGradeFilter,
  label: "Color Grade",
  handler: filterHandler,
  defaultParameters: {
    colorModel: V1_AUTHORED_COLOR_MODEL,
    kneeThreshold: DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold,
    kneeSoftness: DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness,
    toeAmount: DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount,
    toeSoftness: DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness,
    ditherStrength: 1,
    ...DEFAULT_COLOR_QUALIFIER,
    ...DEFAULT_COLOR_CURVES,
    ...DEFAULT_COLOR_GRADE_LUT,
  },
  uiConfig: {
    groups: [
      {
        id: "color_grade_management",
        title: "Grade",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "Grade management",
            name: "_gradeManagement",
            componentId: GRADE_MANAGEMENT_CONTROL_ID,
          },
        ],
      },
      {
        id: "color_grade_qualifier",
        title: "Qualifier",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "Qualifier",
            name: "_qualifier",
            componentId: QUALIFIER_CONTROL_ID,
          },
        ],
      },
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
          ...COLOR_WHEEL_PARAMETER_CONTROLS,
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
            label: "Pivot",
            name: "pivot",
            defaultValue: DEFAULT_COLOR_GRADE_PRIMARIES.pivot,
            min: 0,
            max: 1,
            step: 0.005,
            supportsSpline: true,
          },
          {
            type: "custom",
            label: "Tone shaping",
            name: "_toneShaping",
            componentId: TONE_SHAPING_CONTROL_ID,
          },
          ...TONE_SHAPING_PARAMETER_CONTROLS,
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
      {
        id: "color_grade_lut",
        title: "Creative LUT",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "LUT",
            name: "_lut",
            componentId: LUT_CONTROL_ID,
          },
          {
            type: "slider",
            label: "LUT intensity",
            name: "lutIntensity",
            defaultValue: DEFAULT_COLOR_GRADE_LUT.lutIntensity,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
        ],
      },
      {
        // Extension zone. The group is static and titleless, so it collapses to
        // nothing until an extension places a control here. Commits are limited
        // to real V1 grade parameters.
        id: "color_grade_extensions",
        title: "",
        columns: 1,
        controls: [
          {
            type: "custom",
            label: "Extensions",
            name: "_extensions",
            componentId: EXTENSION_PANEL_CONTROL_ZONE_ID,
            config: {
              filterName: COLOR_GRADE_FILTER_NAME,
              zone: "extensions",
            },
            parameterNames: COLOR_GRADE_PARAMETER_NAMES,
          },
        ],
      },
    ],
  },
};
