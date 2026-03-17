import { describe, expect, it } from "vitest";
import { readWorkflowFromIframe } from "../workflowBridge";

describe("workflowBridge", () => {
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
