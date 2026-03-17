import { HslAdjustmentFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const hslFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "HslAdjustmentFilter",
  FilterClass: HslAdjustmentFilter,
  label: "Color (HSL)",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "color",
        title: "Color",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Hue",
            name: "hue",
            defaultValue: 0,
            min: -180,
            max: 180,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Saturation",
            name: "saturation",
            defaultValue: 0,
            min: -1,
            max: 1,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Lightness",
            name: "lightness",
            defaultValue: 0,
            min: -1,
            max: 1,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Alpha",
            name: "alpha",
            defaultValue: 1,
            min: 0,
            max: 1,
            step: 0.05,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
