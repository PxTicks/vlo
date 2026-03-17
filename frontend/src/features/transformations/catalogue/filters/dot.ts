import { DotFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const dotFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "DotFilter",
  FilterClass: DotFilter,
  label: "Dot",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "dot_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Scale",
            name: "scale",
            defaultValue: 1,
            min: 0.1,
            max: 10,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Angle",
            name: "angle",
            defaultValue: 5,
            min: 0,
            max: 360,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "link",
            label: "Grayscale",
            name: "grayscale",
            defaultValue: true,
          },
        ],
      },
    ],
  },
};
