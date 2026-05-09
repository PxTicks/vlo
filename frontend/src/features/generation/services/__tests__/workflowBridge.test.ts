import { describe, expect, it } from "vitest";
import {
  buildWorkflowResultFromGraphData,
  parseInputsFromGraphData,
  parseWorkflowInputs,
  readActiveWorkflowFromIframe,
  readWorkflowFromIframe,
  readWorkflowFromIframeDetailed,
} from "../workflowBridge";

describe("workflowBridge", () => {
  it("falls back to VHS_LoadVideoFFmpeg as a discoverable video input", () => {
    const inputs = parseWorkflowInputs({
      "644": {
        class_type: "VHS_LoadVideoFFmpeg",
        inputs: {
          video: "source.mp4",
        },
        _meta: {
          title: "Source video",
        },
      },
    });

    expect(inputs).toEqual([
      {
        id: "644:video",
        nodeId: "644",
        classType: "VHS_LoadVideoFFmpeg",
        inputType: "video",
        param: "video",
        label: "Source video",
        description: null,
        currentValue: "source.mp4",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("falls back to VLOMemoryLoadVideo as a discoverable video input", () => {
    const inputs = parseWorkflowInputs({
      "145": {
        class_type: "VLOMemoryLoadVideo",
        inputs: {
          file: "memory-video-1",
        },
        _meta: {
          title: "Source video",
        },
      },
    });

    expect(inputs).toEqual([
      {
        id: "145:file",
        nodeId: "145",
        classType: "VLOMemoryLoadVideo",
        inputType: "video",
        param: "file",
        label: "Source video",
        description: null,
        currentValue: "memory-video-1",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("falls back to object_info display_name when an API workflow node has no title", () => {
    const inputs = parseWorkflowInputs(
      {
        "145": {
          class_type: "CheckpointLoaderSimple",
          inputs: {
            ckpt_name: "model.safetensors",
          },
        },
      },
      {
        CheckpointLoaderSimple: [
          {
            inputType: "image",
            param: "ckpt_name",
          },
        ],
      },
      {
        CheckpointLoaderSimple: {
          display_name: "Load Checkpoint",
        },
      },
    );

    expect(inputs).toEqual([
      {
        id: "145:ckpt_name",
        nodeId: "145",
        classType: "CheckpointLoaderSimple",
        inputType: "image",
        param: "ckpt_name",
        label: "Load Checkpoint",
        description: null,
        currentValue: "model.safetensors",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("prefers activeWorkflow.activeState as the persisted graph source", async () => {
    const activeState = {
      nodes: [{ id: 1, widgets_values: ["new-model.safetensors"] }],
      extra: { source: "activeState" },
    };
    const rawWorkflow = {
      "1": {
        class_type: "LoadImage",
        inputs: { image: "input.png" },
        _meta: { title: "Image" },
      },
    };

    const iframe = {
      contentWindow: {
        app: {
          graphToPrompt: async () => ({
            output: rawWorkflow,
            workflow: {
              nodes: [{ id: 1, widgets_values: ["stale-model.safetensors"] }],
              extra: { source: "graphToPrompt" },
            },
          }),
          extensionManager: {
            workflow: {
              activeWorkflow: {
                path: "workflows/wf (1).json",
                key: "wf (1).json",
                activeState,
              },
            },
          },
        },
      },
    } as unknown as HTMLIFrameElement;

    const result = await readWorkflowFromIframe(iframe);

    expect(result).not.toBeNull();
    expect(result?.filename).toBe("wf (1).json");
    expect(result?.workflow).toEqual(rawWorkflow);
    expect(result?.graphData).toEqual(activeState);
  });

  it("reads the active workflow snapshot without resolving graphToPrompt", () => {
    const activeState = {
      nodes: [{ id: 1, type: "LoadImage" }],
      links: [],
    };
    const iframe = {
      contentWindow: {
        app: {
          extensionManager: {
            workflow: {
              activeWorkflow: {
                path: "workflows/live-edit.json",
                key: "live-edit.json",
                isModified: true,
                activeState,
              },
            },
          },
        },
      },
    } as unknown as HTMLIFrameElement;

    expect(readActiveWorkflowFromIframe(iframe)).toEqual({
      graphData: activeState,
      filename: "live-edit.json",
      isModified: true,
    });
  });

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

  it("classifies InvalidLinkError graph reads as transient invalid graph states", async () => {
    const error = new Error(
      "No link found in parent graph for id [239] slot [0] on_false",
    );
    error.name = "InvalidLinkError";

    const iframe = {
      contentWindow: {
        app: {
          graphToPrompt: async () => {
            throw error;
          },
          extensionManager: {
            workflow: {
              activeWorkflow: {
                path: "workflows/wf.json",
                key: "wf.json",
                activeState: {
                  nodes: [{ id: 239, type: "IfElse" }],
                },
              },
            },
          },
        },
      },
    } as unknown as HTMLIFrameElement;

    const detailed = await readWorkflowFromIframeDetailed(iframe);
    const result = await readWorkflowFromIframe(iframe);

    expect(detailed.status).toBe("invalid_graph");
    expect(detailed.result).toBeNull();
    expect(result).toBeNull();
  });
});
