import type { Processor } from "../types";
import type { FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";

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
    const inputByNodeId = new Map(
      ctx.workflowInputs.map((input) => [input.nodeId, input]),
    );

    for (const [nodeId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputByNodeId.get(nodeId);
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
      ctx.imageInputs[nodeId] = value.file;
    }
  },
};
