import type { TransformHandler, TransformationDefinition } from "../types";
import type { SpeedTransform } from "../../types";

// Speed is handled in the Render Loop (Time warping) rather than the Visual Pass.
// However, we register it here so the Catalogue doesn't crash if it encounters the type.
// It is effectively a No-Op for the Pixi View State.

const speedHandler: TransformHandler<SpeedTransform> = () => {
  // No visual changes to state.
};

export const speedDefinition: TransformationDefinition = {
  type: "speed",
  label: "Speed Adjustment",
  handler: speedHandler,
  uiConfig: {
    groups: [
      {
        id: "speed",
        title: "SPEED (Multiplier)",
        columns: 1,
        controls: [
          {
            type: "number",
            label: "Factor",
            name: "factor",
            defaultValue: 1,
            step: 0.1,
            supportsSpline: true,
            min: 0,
            max: 10,
            softMax: 4,
          },
        ],
      },
    ],
  },
};
