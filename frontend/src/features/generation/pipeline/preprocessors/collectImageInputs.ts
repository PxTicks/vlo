import type { Processor } from "../types";
import type { FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../../utils/workflowInputs";

/**
 * Collects image slot values and routes them to either `imageInputs`
 * (for direct node injection) or `manualSlotImageInputs` (for manual slots).
 */
export const collectImageInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectImageInputs",
    reads: ["slotValues", "workflowInputs"],
    writes: ["imageInputs", "manualSlotImageInputs"],
    description:
      "Routes image slot values to node inputs or manual slot inputs",
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
        if (dispatch.slotInputType !== "image") {
          continue;
        }
        if (value.type !== "image") {
          throw new Error(`Slot '${dispatch.slotId}' expects an image input`);
        }
        ctx.manualSlotImageInputs[dispatch.slotId] = value.file;
        continue;
      }

      if (value.type !== "image") continue;
      if (!input) continue;
      ctx.imageInputs[getNodeInputRequestKey(input, inputById)] = value.file;
    }
  },
};
