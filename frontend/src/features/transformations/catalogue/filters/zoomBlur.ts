import { ZoomBlurFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const zoomBlurFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "ZoomBlurFilter",
  FilterClass: ZoomBlurFilter,
  label: "Zoom Blur",
  handler: filterHandler,
  filterParameterScale: {
    innerRadius: "worldUniform",
    radius: "worldUniform",
  },
  filterParameterPoints: [{ x: "centerX", y: "centerY", space: "inputLocal" }],
  uiConfig: {
    groups: [
      {
        id: "zoomblur_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Strength",
            name: "strength",
            defaultValue: 0.1,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Inner Radius",
            name: "innerRadius",
            defaultValue: 0,
            min: 0,
            max: 500,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Radius",
            name: "radius",
            defaultValue: -1,
            min: -1,
            max: 1000,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "zoomblur_center",
        title: "Center",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Center X",
            name: "centerX",
            defaultValue: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Center Y",
            name: "centerY",
            defaultValue: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
