import { describe, expect, it } from "vitest";
import { parseWorkflowInputs, readWorkflowFromIframe } from "../workflowBridge";

describe("workflowBridge", () => {
  it("falls back to VHS_LoadVideoFFmpeg as a discoverable video input", () => {
    const inputs = parseWorkflowInputs({
      "644": {
        class_type: "VHS_LoadVideoFFmpeg",
        inputs: {
          video: "source.webm",
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
        currentValue: "source.webm",
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
});
