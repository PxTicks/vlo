import { AsciiFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const asciiFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "AsciiFilter",
  FilterClass: AsciiFilter,
  label: "ASCII",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "ascii_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Size",
            name: "size",
            defaultValue: 8,
            min: 2,
            max: 32,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "color",
            label: "Color",
            name: "color",
            defaultValue: 0x000000,
            supportsSpline: false,
          },
          {
            type: "link",
            label: "Replace Color",
            name: "replaceColor",
            defaultValue: false,
          },
        ],
      },
    ],
  },
};
