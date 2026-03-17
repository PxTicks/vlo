import { RGBSplitFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const rgbSplitFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "RGBSplitFilter",
  FilterClass: RGBSplitFilter,
  label: "RGB Split",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "rgbsplit_red",
        title: "Red",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Red X",
            name: "redX",
            defaultValue: -10,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Red Y",
            name: "redY",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "rgbsplit_green",
        title: "Green",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Green X",
            name: "greenX",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Green Y",
            name: "greenY",
            defaultValue: 10,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "rgbsplit_blue",
        title: "Blue",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Blue X",
            name: "blueX",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Blue Y",
            name: "blueY",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
