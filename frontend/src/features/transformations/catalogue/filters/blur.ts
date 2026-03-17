import { BlurFilter } from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const blurFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "BlurFilter",
  FilterClass: BlurFilter,
  label: "Blur",
  handler: filterHandler,
  filterParameterScale: {
    strength: "worldUniform",
  },
  filterPadding: (params) => {
    const strength = params.strength;
    return typeof strength === "number" ? Math.max(0, strength * 2) : 0;
  },
  uiConfig: {
    groups: [
      {
        id: "blur",
        title: "Blur",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Strength",
            name: "strength",
            defaultValue: 0,
            min: 0,
            max: 20,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Quality",
            name: "quality",
            defaultValue: 4,
            min: 1,
            max: 10,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
