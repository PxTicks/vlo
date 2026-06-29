import type { TransformationDefinition } from "../types";
import { audioEffectHandler } from "./audioEffectHandler";

export const panDefinition: TransformationDefinition = {
  type: "pan",
  label: "Pan",
  compatibleClips: "audio",
  handler: audioEffectHandler,
  uiConfig: {
    groups: [
      {
        id: "pan",
        title: "STEREO PAN",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Pan (L ↔ R)",
            name: "pan",
            defaultValue: 0,
            min: -1,
            max: 1,
            step: 0.05,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
