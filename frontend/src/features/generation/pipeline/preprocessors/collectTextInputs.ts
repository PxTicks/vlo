import type { Processor } from "../types";
import type { FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../../utils/workflowInputs";

/**
 * Collects text slot values and routes them to either `textInputs`
 * (for direct node injection) or `manualSlotTextInputs` (for manual slots).
 */
export const collectTextInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectTextInputs",
    reads: ["slotValues", "workflowInputs"],
    writes: ["textInputs", "manualSlotTextInputs"],
    description:
      "Routes text slot values to node inputs or manual slot inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    throwIfAborted(ctx.signal);
    const inputById = buildWorkflowInputLookup(ctx.workflowInputs);

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputById.get(inputId);
      const dispatch = input?.dispatch;

      if (dispatch?.kind === "manual_slot") {
        if (dispatch.slotInputType !== "text") {
          continue;
        }
        if (value.type !== "text") {
          throw new Error(`Slot '${dispatch.slotId}' expects text input`);
        }
        ctx.manualSlotTextInputs[dispatch.slotId] = value.value;
        continue;
      }

      if (value.type !== "text") continue;
      if (!input) continue;
      ctx.textInputs[getNodeInputRequestKey(input, inputById)] = value.value;
    }
  },
};
