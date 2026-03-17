import { BulgePinchFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const bulgePinchFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "BulgePinchFilter",
  FilterClass: BulgePinchFilter,
  label: "Bulge / Pinch",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "bulge_pinch",
        title: "Bulge / Pinch",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Strength",
            name: "strength",
            defaultValue: 1,
            min: -1,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Radius",
            name: "radius",
            defaultValue: 100,
            min: 0,
            max: 1000,
            step: 1,
            supportsSpline: true,
          },
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
