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

  it("prefers the live graphToPrompt graph over activeState for widget values", async () => {
    // activeState is a persisted snapshot that only updates on save; live
    // widget edits (e.g. typed prompt text) may not be reflected there.
    // graphToPrompt returns the current graph, so it wins as graph_data.
    const activeState = {
      nodes: [{ id: 1, widgets_values: ["stale-model.safetensors"] }],
      extra: { source: "activeState" },
    };
    const liveWorkflow = {
      nodes: [{ id: 1, widgets_values: ["live-model.safetensors"] }],
      extra: { source: "graphToPrompt" },
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
            workflow: liveWorkflow,
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
    expect(result?.graphData).toEqual(liveWorkflow);
  });

  it("falls back to activeState when graphToPrompt returns no workflow graph", async () => {
    const activeState = {
      nodes: [{ id: 1, widgets_values: ["persisted-model.safetensors"] }],
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
          graphToPrompt: async () => ({ output: rawWorkflow }),
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
    expect(result?.graphData).toEqual(activeState);
  });
});
