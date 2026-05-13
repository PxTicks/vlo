import { describe, expect, it } from "vitest";
import {
  buildWorkflowResultFromGraphData,
  parseInputsFromGraphData,
  readActiveWorkflowFromIframe,
  readPendingWarningsFromIframe,
} from "../workflowBridge";

function buildIframeWithPendingWarnings(
  pendingWarnings: unknown,
): HTMLIFrameElement {
  return {
    contentWindow: {
      app: {
        extensionManager: {
          workflow: {
            activeWorkflow: {
              filename: "wf.json",
              pendingWarnings,
            },
          },
        },
      },
    },
  } as unknown as HTMLIFrameElement;
}

describe("workflowBridge", () => {
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

  describe("readPendingWarningsFromIframe", () => {
    it("reads the new ComfyUI missingModelCandidates shape", () => {
      const iframe = buildIframeWithPendingWarnings({
        missingNodeTypes: [],
        missingModelCandidates: [
          {
            nodeType: "CheckpointLoaderSimple",
            widgetName: "ckpt_name",
            name: "flux-2-klein-base-9b-fp8.safetensors",
            directory: "diffusion_models",
            url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors",
            isAssetSupported: false,
            isMissing: true,
          },
        ],
      });

      expect(readPendingWarningsFromIframe(iframe)).toEqual({
        missingNodeTypes: [],
        missingModels: ["flux-2-klein-base-9b-fp8.safetensors"],
      });
    });

    it("filters out candidates where isMissing is not true", () => {
      const iframe = buildIframeWithPendingWarnings({
        missingModelCandidates: [
          { name: "installed.safetensors", isMissing: false },
          { name: "pending.safetensors", isMissing: undefined },
          { name: "really-missing.safetensors", isMissing: true },
        ],
      });

      expect(readPendingWarningsFromIframe(iframe)).toEqual({
        missingNodeTypes: [],
        missingModels: ["really-missing.safetensors"],
      });
    });

    it("falls back to the legacy missingModels key for older ComfyUI builds", () => {
      const iframe = buildIframeWithPendingWarnings({
        missingModels: [{ name: "legacy.safetensors" }],
      });

      expect(readPendingWarningsFromIframe(iframe)).toEqual({
        missingNodeTypes: [],
        missingModels: ["legacy.safetensors"],
      });
    });

    it("returns null when no warnings are present", () => {
      const iframe = buildIframeWithPendingWarnings(null);
      expect(readPendingWarningsFromIframe(iframe)).toBeNull();
    });
  });
});
