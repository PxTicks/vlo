import type { TransformationDefinition } from "../types";
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
            defaultValue: -24,
            min: -100,
            max: 0,
            step: 1,
          },
          {
            type: "slider",
            label: "Ratio",
            name: "ratio",
            defaultValue: 4,
            min: 1,
            max: 20,
            step: 0.5,
          },
          {
            type: "slider",
            label: "Attack (s)",
            name: "attack",
            defaultValue: 0.003,
            min: 0,
            max: 1,
            step: 0.001,
          },
          {
            type: "slider",
            label: "Release (s)",
            name: "release",
            defaultValue: 0.25,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            type: "slider",
            label: "Knee (dB)",
            name: "knee",
            defaultValue: 30,
            min: 0,
            max: 40,
            step: 1,
          },
          {
            type: "slider",
            label: "Makeup Gain",
            name: "makeup",
            defaultValue: 1,
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
