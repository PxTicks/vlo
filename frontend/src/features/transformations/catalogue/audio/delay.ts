import type { TransformationDefinition } from "../types";
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
            defaultValue: 0.3,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Feedback",
            name: "feedback",
            defaultValue: 0.4,
            min: 0,
            max: 0.95,
            step: 0.05,
            supportsSpline: true,
          },
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
        ],
      },
    ],
  },
};
