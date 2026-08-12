import type { FrontendPreprocessContext, Processor } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKeyForSlot,
  resolveWorkflowInputForSlot,
} from "../../utils/workflowInputs";

/**
 * Collects audio slot values and routes them to `audioInputs`
 * for direct node injection.
 */
export const collectAudioInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectAudioInputs",
    reads: ["slotValues", "workflowInputs"],
    writes: ["audioInputs"],
    description: "Routes audio slot values to node inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    throwIfAborted(ctx.signal);
    const inputById = buildWorkflowInputLookup(ctx.workflowInputs);

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      if (value.type !== "audio") continue;
      const input = resolveWorkflowInputForSlot(inputId, inputById);
      if (!input) continue;
      ctx.audioInputs[
        getNodeInputRequestKeyForSlot(inputId, input, inputById)
      ] = value.file;
    }
  },
};
