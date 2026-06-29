import type { TransformationDefinition } from "../types";
import { AUDIO_DELAY_DEFAULTS } from "../../constants";
import { audioEffectHandler } from "./audioEffectHandler";

// Feedback delay / echo (DelayNode + feedback gain), blended wet/dry by `mix`.
export const delayDefinition: TransformationDefinition = {
  type: "delay",
  label: "Delay / Echo",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "delay",
        title: "DELAY / ECHO",
        columns: 2,
        controls: [
          {
            type: "slider",
            label: "Time (s)",
            name: "time",
            defaultValue: AUDIO_DELAY_DEFAULTS.time,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Feedback",
            name: "feedback",
            defaultValue: AUDIO_DELAY_DEFAULTS.feedback,
            min: 0,
            max: 0.95,
            step: 0.05,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Mix",
            name: "mix",
            defaultValue: AUDIO_DELAY_DEFAULTS.mix,
            min: 0,
            max: 1,
            step: 0.05,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
