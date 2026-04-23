import { AlphaFilter } from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const alphaFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "AlphaFilter",
  FilterClass: AlphaFilter,
  label: "Alpha",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "alpha",
        title: "Alpha",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Alpha",
            name: "alpha",
            defaultValue: 1,
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
