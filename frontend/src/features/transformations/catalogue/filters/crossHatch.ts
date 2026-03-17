import { CrossHatchFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const crossHatchFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "CrossHatchFilter",
  FilterClass: CrossHatchFilter,
  label: "Cross Hatch",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "crosshatch_settings",
        title: "Settings",
        columns: 1,
        controls: [],
      },
    ],
  },
};
