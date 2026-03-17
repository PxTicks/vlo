import { GlowFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const glowFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "GlowFilter",
  FilterClass: GlowFilter,
  label: "Glow",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "glow",
        title: "Glow",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Distance",
            name: "distance",
            defaultValue: 10,
            min: 0,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Outer Strength",
            name: "outerStrength",
            defaultValue: 4,
            min: 0,
            max: 20,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Inner Strength",
            name: "innerStrength",
            defaultValue: 0,
            min: 0,
            max: 20,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "color",
            label: "Color",
            name: "color",
            defaultValue: 0xffffff,
            supportsSpline: false,
          },
          {
            type: "slider",
            label: "Quality",
            name: "quality",
            defaultValue: 0.1,
            min: 0.0,
            max: 1.0,
            step: 0.05,
            supportsSpline: false,
          },
          {
            type: "select",
            label: "Knockout",
            name: "knockout",
            defaultValue: false,
            options: [
              { label: "Off", value: false },
              { label: "On", value: true },
            ],
            supportsSpline: false,
          },
        ],
      },
    ],
  },
};
