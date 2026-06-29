import type { TransformationDefinition } from "../types";
import { audioEffectHandler } from "./audioEffectHandler";

// 3-band parametric EQ: low shelf, peaking mid, high shelf.
// All controls live in a single group whose id matches the transform type
// ("audioEq") so the equalizer can render as an always-present default section
// (default sections bind one UI group per transform type).
export const eqDefinition: TransformationDefinition = {
  type: "audioEq",
  label: "Equalizer",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "audioEq",
        title: "EQUALIZER",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Low (dB)",
            name: "lowGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "Low Freq",
            name: "lowFreq",
            defaultValue: 200,
            min: 20,
            max: 2000,
            step: 10,
          },
          {
            type: "slider",
            label: "Mid (dB)",
            name: "midGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "Mid Freq",
            name: "midFreq",
            defaultValue: 1000,
            min: 200,
            max: 8000,
            step: 50,
          },
          {
            type: "slider",
            label: "High (dB)",
            name: "highGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "High Freq",
            name: "highFreq",
            defaultValue: 4000,
            min: 1000,
            max: 16000,
            step: 100,
          },
        ],
      },
    ],
  },
};
