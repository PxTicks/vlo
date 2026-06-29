import type { TransformationDefinition } from "../types";
import { AUDIO_REVERB_DEFAULTS } from "../../constants";
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
            defaultValue: AUDIO_REVERB_DEFAULTS.mix,
            min: 0,
            max: 1,
            step: 0.05,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Decay (s)",
            name: "decay",
            defaultValue: AUDIO_REVERB_DEFAULTS.decay,
            min: 0.1,
            max: 10,
            step: 0.1,
          },
        ],
      },
    ],
  },
};
