import type { Processor } from "../types";
import type { FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../../utils/workflowInputs";

/**
 * Collects text slot values and routes them to `textInputs`
 * for direct node injection.
 */
export const collectTextInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectTextInputs",
    reads: ["slotValues", "workflowInputs"],
    writes: ["textInputs"],
    description:
      "Routes text slot values to node inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    throwIfAborted(ctx.signal);
    const inputById = buildWorkflowInputLookup(ctx.workflowInputs);

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      if (value.type !== "text") continue;
      const input = inputById.get(inputId);
      if (!input) continue;
      ctx.textInputs[getNodeInputRequestKey(input, inputById)] = value.value;
    }
  },
};
