import type { TransformHandler, TransformationDefinition } from "../types";
import type { VolumeTransform } from "../../types";

// Volume is handled in the Audio Renderer rather than the Visual Pass.
// Similar to Speed, it's a No-Op for the Pixi View State.
const volumeHandler: TransformHandler<VolumeTransform> = () => {
  // No visual changes to state.
};

export const volumeDefinition: TransformationDefinition = {
  type: "volume",
  label: "Volume",
  compatibleClips: "audio",
  handler: volumeHandler,
  uiConfig: {
    groups: [
      {
        id: "volume",
        title: "VOLUME (Multiplier)",
        columns: 1,
        controls: [
          {
            type: "number",
            label: "Gain",
            name: "gain",
            defaultValue: 1.0,
            step: 0.1,
            supportsSpline: true,
            min: 0,
            max: 2.0,
            softMax: 1.5,
          },
        ],
      },
    ],
  },
};
