import { GlitchFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const glitchFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "GlitchFilter",
  FilterClass: GlitchFilter,
  label: "Glitch",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "glitch_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Slices",
            name: "slices",
            defaultValue: 5,
            min: 1,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Offset",
            name: "offset",
            defaultValue: 100,
            min: 0,
            max: 500,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Direction",
            name: "direction",
            defaultValue: 0,
            min: -180,
            max: 180,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Seed",
            name: "seed",
            defaultValue: 0,
            min: 0,
            max: 100,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Min Size",
            name: "minSize",
            defaultValue: 8,
            min: 1,
            max: 100,
            step: 1,
            supportsSpline: false,
          },
          {
            type: "link",
            label: "Average",
            name: "average",
            defaultValue: false,
          },
        ],
      },
    ],
  },
};
