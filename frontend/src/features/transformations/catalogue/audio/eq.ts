import type { TransformationDefinition } from "../types";
import { audioEffectHandler } from "./audioEffectHandler";

// 3-band parametric EQ: low shelf, peaking mid, high shelf.
// Each band is a BiquadFilterNode in the audio renderer chain.
export const eqDefinition: TransformationDefinition = {
  type: "audioEq",
  label: "Equalizer",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "eq_low",
        title: "LOW (Shelf)",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Gain (dB)",
            name: "lowGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "Freq (Hz)",
            name: "lowFreq",
            defaultValue: 200,
            min: 20,
            max: 2000,
            step: 10,
          },
        ],
      },
      {
        id: "eq_mid",
        title: "MID (Peaking)",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Gain (dB)",
            name: "midGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "Freq (Hz)",
            name: "midFreq",
            defaultValue: 1000,
            min: 200,
            max: 8000,
            step: 50,
          },
        ],
      },
      {
        id: "eq_high",
        title: "HIGH (Shelf)",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Gain (dB)",
            name: "highGain",
            defaultValue: 0,
            min: -24,
            max: 24,
            step: 0.5,
            supportsSpline: true,
          },
          {
            type: "number",
            label: "Freq (Hz)",
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
