import { BloomFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const bloomFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "BloomFilter",
  FilterClass: BloomFilter,
  label: "Bloom",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "bloom",
        title: "Bloom",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Strength",
            name: "strength",
            defaultValue: 2,
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
