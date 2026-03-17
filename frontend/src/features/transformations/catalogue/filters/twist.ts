import { TwistFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

function getNumericParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = params[key];
  return typeof value === "number" ? Math.abs(value) : 0;
}

class StableTwistFilter extends TwistFilter {
  constructor() {
    super();

    // pixi-filters reuses TwistFilter.DEFAULT_OPTIONS.offset across instances.
    // Clone it so simultaneous Twist filters cannot overwrite each other's center.
    const { x, y } = this.offset;
    this.offset = { x, y };
  }
}

export const twistFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "TwistFilter",
  FilterClass: StableTwistFilter,
  label: "Twist",
  handler: filterHandler,
  filterParameterScale: {
    radius: "worldUniform",
  },
  filterParameterPoints: [{ x: "offsetX", y: "offsetY", space: "inputLocal" }],
  filterPadding: (params) => Math.max(20, getNumericParam(params, "radius")),
  uiConfig: {
    groups: [
      {
        id: "twist_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Radius",
            name: "radius",
            defaultValue: 200,
            min: 0,
            max: 1000,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Angle",
            name: "angle",
            defaultValue: 4,
            min: -10,
            max: 10,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Offset X",
            name: "offsetX",
            defaultValue: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Offset Y",
            name: "offsetY",
            defaultValue: 0.5,
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
