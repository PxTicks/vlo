import { describe, expect, it } from "vitest";

import type { WorkflowInput } from "../../types";
import {
  carryOverMediaInputs,
  carryOverTextValues,
} from "../workflowInputCarryover";

function makeInput(overrides: Partial<WorkflowInput>): WorkflowInput {
  return {
    nodeId: "1",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "inferred",
    ...overrides,
  };
}

describe("workflowInputCarryover", () => {
  it("carries prompt values across workflow switches by semantic label", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "11",
        label: "Positive Prompt",
        currentValue: "sunrise over a lake",
      }),
      makeInput({
        nodeId: "12",
        label: "Negative Prompt",
        currentValue: "blurry",
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "31",
        label: "Positive Prompt",
      }),
      makeInput({
        nodeId: "32",
        label: "Negative Prompt",
      }),
    ];

    expect(
      carryOverTextValues(
        previousInputs,
        {
          "11:text": "sunrise over a lake",
          "12:text": "blurry",
        },
        nextInputs,
      ),
    ).toEqual({
      "31:text": "sunrise over a lake",
      "32:text": "blurry",
    });
  });

  it("carries a single compatible image input between workflows", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "101",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Image",
        currentValue: null,
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "202",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Reference Image",
        currentValue: null,
      }),
    ];

    const assetValue = {
      kind: "asset" as const,
      asset: {
        id: "asset-1",
        hash: "hash-1",
        name: "frame.png",
        type: "video" as const,
        src: "assets/frame.png",
        createdAt: Date.now(),
      },
    };

    expect(
      carryOverMediaInputs(
        previousInputs,
        { "101:image": assetValue },
        nextInputs,
      ),
    ).toEqual({
      "202:image": assetValue,
    });
  });

  it("does not guess between multiple previous image inputs", () => {
    const previousInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "401",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start Frame",
        currentValue: null,
      }),
      makeInput({
        nodeId: "402",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "End Frame",
        currentValue: null,
      }),
    ];

    const nextInputs: WorkflowInput[] = [
      makeInput({
        nodeId: "501",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Reference Image",
        currentValue: null,
      }),
    ];

    expect(
      carryOverMediaInputs(
        previousInputs,
        {
          "401:image": {
            kind: "asset",
            asset: {
              id: "asset-start",
              hash: "hash-start",
              name: "start.png",
              type: "image",
              src: "assets/start.png",
              createdAt: Date.now(),
            },
          },
          "402:image": {
            kind: "asset",
            asset: {
              id: "asset-end",
              hash: "hash-end",
              name: "end.png",
              type: "image",
              src: "assets/end.png",
              createdAt: Date.now(),
            },
          },
        },
        nextInputs,
      ),
    ).toEqual({});
  });

  it("preserves ordered repeatable media values for the same workflow input", () => {
    const repeatableInput = makeInput({
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      presentation: { repeatable: { max: 9 } },
    });
    const first = {
      kind: "asset" as const,
      asset: {
        id: "first",
        hash: "first",
        name: "first.png",
        type: "image" as const,
        src: "assets/first.png",
        createdAt: 1,
      },
    };
    const second = {
      kind: "asset" as const,
      asset: {
        id: "second",
        hash: "second",
        name: "second.png",
        type: "image" as const,
        src: "assets/second.png",
        createdAt: 2,
      },
    };

    expect(
      carryOverMediaInputs(
        [repeatableInput],
        {
          "141:images": first,
          "141:images::repeat::1": second,
        },
        [repeatableInput],
      ),
    ).toEqual({
      "141:images": first,
      "141:images::repeat::1": second,
    });
  });
});
