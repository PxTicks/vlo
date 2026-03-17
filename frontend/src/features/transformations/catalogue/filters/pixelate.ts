import { PixelateFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const pixelateFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "PixelateFilter",
  FilterClass: PixelateFilter,
  label: "Pixelate",
  handler: filterHandler,
  filterParameterScale: {
    sizeX: "worldX",
    sizeY: "worldY",
  },
  uiConfig: {
    groups: [
      {
        id: "pixelate_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Size X",
            name: "sizeX",
            defaultValue: 10,
            min: 1,
            max: 100,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Size Y",
            name: "sizeY",
            defaultValue: 10,
            min: 1,
            max: 100,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
