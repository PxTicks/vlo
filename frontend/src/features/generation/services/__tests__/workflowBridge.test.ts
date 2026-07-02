import { describe, expect, it } from "vitest";
import {
  buildWorkflowResultFromGraphData,
  parseInputsFromGraphData,
} from "../workflowBridge";

// Iframe access now lives in vlo's hosted bridge; only pure LiteGraph-JSON
// parsing remains here.

describe("workflowBridge", () => {
  it("builds workflow inputs from activeState widget values using object_info", () => {
    const result = buildWorkflowResultFromGraphData(
      {
        nodes: [
          {
            id: 145,
            type: "LoadImage",
            title: "Source image",
            widgets_values: ["source.png"],
          },
        ],
        links: [],
      },
      "wf.json",
      {
        inputNodeMap: {
          LoadImage: [
            {
              inputType: "image",
              param: "image",
            },
          ],
        },
        objectInfo: {
          LoadImage: {
            input: {
              required: {
                image: ["STRING", {}],
              },
            },
            input_order: {
              required: ["image"],
            },
          },
        },
      },
    );

    expect(result.workflow).toBeNull();
    expect(result.inputs).toEqual([
      {
        id: "145:image",
        nodeId: "145",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Source image",
        description: null,
        currentValue: "source.png",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("derives panel inputs directly from a visual graph without round-tripping API shape", () => {
    const inputs = parseInputsFromGraphData(
      {
        nodes: [
          {
            id: 1,
            type: "LoadImage",
            title: "Start frame",
            widgets_values: ["source.png"],
          },
          {
            id: 2,
            type: "PreviewImage",
            inputs: [{ name: "images", link: 10 }],
          },
        ],
        links: [[10, 1, 0, 2, 0, "IMAGE"]],
      },
      {
        inputNodeMap: {
          LoadImage: [
            {
              inputType: "image",
              param: "image",
            },
          ],
        },
        objectInfo: {
          LoadImage: {
            input: {
              required: {
                image: ["STRING", {}],
              },
            },
            input_order: {
              required: ["image"],
            },
          },
        },
      },
    );

    expect(inputs).toEqual([
      {
        id: "1:image",
        nodeId: "1",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start frame",
        description: null,
        currentValue: "source.png",
        origin: "inferred",
        dispatch: { kind: "node" },
      },
    ]);
  });

  it("falls back to object_info display_name when a graph node has no title", () => {
    const inputs = parseInputsFromGraphData(
      {
        nodes: [
          {
            id: 1,
            type: "CheckpointLoaderSimple",
            widgets_values: ["model.safetensors"],
          },
        ],
        links: [],
      },
      {
        inputNodeMap: {
          CheckpointLoaderSimple: [
            {
              inputType: "image",
              param: "ckpt_name",
            },
          ],
        },
        objectInfo: {
          CheckpointLoaderSimple: {
            display_name: "Load Checkpoint",
            input: {
              required: {
                ckpt_name: ["STRING", {}],
              },
            },
            input_order: {
              required: ["ckpt_name"],
            },
          },
        },
      },
    );

    expect(inputs[0]?.label).toBe("Load Checkpoint");
  });

  it("discovers lowercase vloMemoryLoadVideo graph nodes with legacy uppercase metadata", () => {
    const inputs = parseInputsFromGraphData(
      {
        nodes: [
          {
            id: 129,
            type: "vloMemoryLoadVideo",
            widgets_values: ["memory-video-1"],
          },
        ],
        links: [],
      },
      {
        inputNodeMap: {
          VLOMemoryLoadVideo: [
            {
              inputType: "video",
              param: "file",
            },
          ],
        },
        objectInfo: {
          VLOMemoryLoadVideo: {
            display_name: "Load Video",
            input: {
              required: {
                file: ["STRING", {}],
              },
            },
            input_order: {
              required: ["file"],
            },
          },
        },
      },
    );

    expect(inputs).toEqual([
      {
        id: "129:file",
        nodeId: "129",
        classType: "vloMemoryLoadVideo",
        inputType: "video",
        param: "file",
        label: "Load Video",
        description: null,
        currentValue: "memory-video-1",
        origin: "inferred",
        dispatch: { kind: "node" },
      },
    ]);
  });

  it("sorts graph nodes, skips disabled/invalid nodes, and labels multi-input mappings", () => {
    const inputs = parseInputsFromGraphData(
      {
        nodes: [
          { id: "z", type: "Ignored" },
          {
            id: 10,
            type: "Multi",
            title: "Multiple",
            widgets_values: [7, "skip", true, "choice"],
            inputs: [{ name: "linked", link: 3 }],
          },
          { id: 2, type: "Single", widgets_values: ["first"] },
          { id: 3, type: "Single", mode: 2, widgets_values: ["disabled"] },
          { id: 4, type: "Single", mode: 4, widgets_values: ["muted"] },
          null,
          { id: null, type: "Single" },
          { id: 5, type: 42 },
        ],
      },
      {
        inputNodeMap: {
          Single: [{ inputType: "text", param: "value" }],
          Multi: [
            { inputType: "text", param: "amount", label: "Amount" },
            { inputType: "text", param: "linked" },
            { inputType: "text", param: "choice" },
          ],
        },
        objectInfo: {
          Single: {
            display_name: "Single node",
            input: { required: { value: ["STRING", {}] } },
          },
          Multi: {
            input: {
              required: {
                amount: ["INT", { control_after_generate: true }],
                socket: ["IMAGE", {}],
                linked: ["BOOLEAN", {}],
              },
              optional: {
                choice: [["a", "b"], {}],
                ignoredCombo: ["COMBO", {}],
              },
            },
            input_order: {
              required: ["amount", "", 4, "socket", "linked"],
              optional: ["choice", "ignoredCombo"],
            },
          },
        },
      },
    );

    expect(inputs.map((input) => input.id)).toEqual([
      "2:value",
      "10:amount",
      "10:linked",
      "10:choice",
    ]);
    expect(inputs[0]).toMatchObject({
      label: "Single node",
      currentValue: "first",
    });
    expect(inputs[1]).toMatchObject({ label: "Amount", currentValue: 7 });
    expect(inputs[2]).toMatchObject({ label: "linked", currentValue: null });
    expect(inputs[3]).toMatchObject({ label: "choice", currentValue: "choice" });
  });

  it("falls back to the first widget for a single mapping without object info", () => {
    expect(
      parseInputsFromGraphData(
        {
          nodes: [
            {
              id: "custom",
              type: " CustomNode ",
              widgets_values: ["fallback"],
            },
          ],
        },
        {
          inputNodeMap: {
            CustomNode: [
              {
                inputType: "text",
                param: "prompt",
                description: "Describe it",
              },
            ],
          },
        },
      )[0],
    ).toMatchObject({
      id: "custom:prompt",
      label: "CustomNode",
      description: "Describe it",
      currentValue: "fallback",
    });
  });

  it("returns an empty input list for malformed graph data or unknown mappings", () => {
    expect(parseInputsFromGraphData({ nodes: "bad" })).toEqual([]);
    expect(
      parseInputsFromGraphData(
        { nodes: [{ id: 1, type: "Unknown" }] },
        { inputNodeMap: {} },
      ),
    ).toEqual([]);
  });

});
