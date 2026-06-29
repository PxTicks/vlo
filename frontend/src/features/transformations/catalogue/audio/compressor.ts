import type { TransformationDefinition } from "../types";
import { AUDIO_COMPRESSOR_DEFAULTS } from "../../constants";
import { audioEffectHandler } from "./audioEffectHandler";

// Dynamics compressor (DynamicsCompressorNode) + makeup gain.
export const compressorDefinition: TransformationDefinition = {
  type: "compressor",
  label: "Compressor",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "compressor",
        title: "COMPRESSOR",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Threshold (dB)",
            name: "threshold",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.threshold,
            min: -100,
            max: 0,
            step: 1,
          },
          {
            type: "slider",
            label: "Ratio",
            name: "ratio",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.ratio,
            min: 1,
            max: 20,
            step: 0.5,
          },
          {
            type: "slider",
            label: "Attack (s)",
            name: "attack",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.attack,
            min: 0,
            max: 1,
            step: 0.001,
          },
          {
            type: "slider",
            label: "Release (s)",
            name: "release",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.release,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            type: "slider",
            label: "Knee (dB)",
            name: "knee",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.knee,
            min: 0,
            max: 40,
            step: 1,
          },
          {
            type: "slider",
            label: "Makeup Gain",
            name: "makeup",
            defaultValue: AUDIO_COMPRESSOR_DEFAULTS.makeup,
            min: 0,
            max: 4,
            step: 0.1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
