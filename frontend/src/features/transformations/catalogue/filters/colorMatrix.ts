import { ColorMatrixFilter } from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const colorMatrixDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "ColorMatrix",
  FilterClass: ColorMatrixFilter,
  label: "Color Matrix",
  handler: filterHandler,
  hidden: true,
  uiConfig: {
    groups: [],
  },
};
