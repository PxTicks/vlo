import type { TransformationDefinition } from "../types";
import { audioEffectHandler } from "./audioEffectHandler";

// Convolution reverb. The audio renderer generates a procedural impulse
// response from `decay` and blends wet/dry by `mix` (no IR asset needed).
export const reverbDefinition: TransformationDefinition = {
  type: "reverb",
  label: "Reverb",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "reverb",
        title: "REVERB",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Mix",
            name: "mix",
            defaultValue: 0.3,
            min: 0,
            max: 1,
            step: 0.05,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Decay (s)",
            name: "decay",
            defaultValue: 2,
            min: 0.1,
            max: 10,
            step: 0.1,
          },
        ],
      },
    ],
  },
};
