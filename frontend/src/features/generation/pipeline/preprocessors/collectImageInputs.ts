import type { Processor } from "../types";
import type { FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKeyForSlot,
  resolveWorkflowInputForSlot,
} from "../../utils/workflowInputs";

/**
 * Collects image slot values and routes them to `imageInputs`
 * for direct node injection.
 */
export const collectImageInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectImageInputs",
    reads: ["slotValues", "workflowInputs"],
    writes: ["imageInputs"],
    description:
      "Routes image slot values to node inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    throwIfAborted(ctx.signal);
    const inputById = buildWorkflowInputLookup(ctx.workflowInputs);

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      if (value.type !== "image") continue;
      const input = resolveWorkflowInputForSlot(inputId, inputById);
      if (!input) continue;
      ctx.imageInputs[
        getNodeInputRequestKeyForSlot(inputId, input, inputById)
      ] = value.file;
    }
  },
};
