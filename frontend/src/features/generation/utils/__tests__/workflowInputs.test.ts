import { describe, expect, it } from "vitest";

import type { WorkflowInput } from "../../types";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  getNodeInputRequestKeyForSlot,
  getWorkflowInputSlotValue,
  resolveWorkflowInputForSlot,
} from "../workflowInputs";

describe("repeatable workflow inputs", () => {
  const input: WorkflowInput = {
    id: "141:images",
    nodeId: "141",
    classType: "vloMemoryLoadImageBatch",
    inputType: "image",
    param: "images",
    label: "Image inputs",
    currentValue: null,
    origin: "rule",
    presentation: { repeatable: { max: 9 } },
  };

  it("resolves synthetic slots to their workflow input and unique request keys", () => {
    const inputLookup = buildWorkflowInputLookup([input]);
    const firstId = buildRepeatableInputSlotId(input, 0);
    const secondId = buildRepeatableInputSlotId(input, 1);

    expect(firstId).toBe("141:images");
    expect(secondId).toBe("141:images::repeat::1");
    expect(resolveWorkflowInputForSlot(secondId, inputLookup)).toBe(input);
    expect(getNodeInputRequestKeyForSlot(firstId, input, inputLookup)).toBe(
      "141__repeat_0",
    );
    expect(getNodeInputRequestKeyForSlot(secondId, input, inputLookup)).toBe(
      "141__repeat_1",
    );
  });

  it("retains the legacy bare-node alias for repeatable slot zero", () => {
    const inputLookup = buildWorkflowInputLookup([input]);

    expect(
      getWorkflowInputSlotValue(
        { "141": "legacy-media" },
        input,
        0,
        inputLookup,
      ),
    ).toBe("legacy-media");
  });
});
