import { describe, expect, it, vi } from "vitest";
import {
  buildWorkflowResultFromGraphData,
  isIframeAppReady,
  loadWorkflowIntoIframe,
  parseInputsFromGraphData,
  readActiveWorkflowFromIframe,
  readPendingWarningsFromIframe,
} from "../workflowBridge";

type ReadyAppOverrides = {
  handleFile?: unknown;
  canvas?: unknown;
  extensionManager?: unknown;
};

function buildIframeWithApp(
  app: ReadyAppOverrides | null,
): HTMLIFrameElement {
  return {
    contentWindow: { app },
  } as unknown as HTMLIFrameElement;
}

function buildReadyIframe(
  overrides: ReadyAppOverrides = {},
): HTMLIFrameElement {
  return buildIframeWithApp({
    handleFile: vi.fn(),
    canvas: {},
    extensionManager: {
      spinner: false,
      workflow: {
        activeWorkflow: { filename: "wf.json" },
      },
    },
    ...overrides,
  });
}

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

  describe("loadWorkflowIntoIframe", () => {
    it("reads warnings from the injected workflow tab instead of the previously active one", async () => {
      const oldWorkflow = {
        filename: "video_ltx2_3_i2v.json",
        activeState: {
          nodes: [{ id: 1, type: "OldWorkflow" }],
          links: [],
        },
        pendingWarnings: {
          missingModelCandidates: [
            { name: "ltx-model.safetensors", isMissing: true },
          ],
        },
      };
      const newWorkflow = {
        filename: "wan_video.json",
        activeState: {
          nodes: [{ id: 98, type: "LoadVideo" }],
          links: [],
        },
        pendingWarnings: {
          missingModelCandidates: [
            { name: "wan-model.safetensors", isMissing: true },
          ],
        },
      };
      const workflowApi: {
        activeWorkflow: typeof oldWorkflow | typeof newWorkflow | null;
        openWorkflows: Array<typeof oldWorkflow | typeof newWorkflow>;
        closeWorkflow: ReturnType<typeof vi.fn>;
      } = {
        activeWorkflow: oldWorkflow,
        openWorkflows: [oldWorkflow],
        closeWorkflow: vi.fn(async (workflow) => {
          workflowApi.openWorkflows = workflowApi.openWorkflows.filter(
            (candidate) => candidate !== workflow,
          );
          if (workflowApi.activeWorkflow === workflow) {
            workflowApi.activeWorkflow = workflowApi.openWorkflows[0] ?? null;
          }
        }),
      };
      const handleFile = vi.fn(async () => {
        workflowApi.openWorkflows = [oldWorkflow, newWorkflow];
      });
      const iframe = {
        contentWindow: {
          app: {
            handleFile,
            extensionManager: {
              workflow: workflowApi,
            },
          },
        },
      } as unknown as HTMLIFrameElement;

      const result = await loadWorkflowIntoIframe(
        iframe,
        {
          nodes: [{ id: 98, type: "LoadVideo" }],
          links: [],
        },
        "wan_video.json",
        {
          deferWarnings: true,
          capturePendingWarnings: true,
        },
      );

      expect(result).toEqual({
        ok: true,
        warnings: {
          missingNodeTypes: [],
          missingModels: ["wan-model.safetensors"],
        },
      });
      expect(workflowApi.closeWorkflow).toHaveBeenCalledTimes(1);
      expect(workflowApi.closeWorkflow).toHaveBeenCalledWith(oldWorkflow);
      expect(oldWorkflow.pendingWarnings).toEqual({
        missingModelCandidates: [
          { name: "ltx-model.safetensors", isMissing: true },
        ],
      });
      expect(newWorkflow.pendingWarnings).toBeNull();
    });
  });

  describe("isIframeAppReady", () => {
    it("returns true once the full GraphCanvas onMounted sequence has completed", () => {
      expect(isIframeAppReady(buildReadyIframe())).toBe(true);
    });

    it("returns false when contentWindow has no app", () => {
      expect(isIframeAppReady(buildIframeWithApp(null))).toBe(false);
    });

    it("returns false when canvas is not yet created (mid-setup)", () => {
      expect(isIframeAppReady(buildReadyIframe({ canvas: undefined }))).toBe(
        false,
      );
    });

    it("returns false while the workspace spinner is still up", () => {
      const iframe = buildReadyIframe({
        extensionManager: {
          spinner: true,
          workflow: {
            activeWorkflow: { filename: "wf.json" },
          },
        },
      });
      expect(isIframeAppReady(iframe)).toBe(false);
    });

    it("returns false before workflowPersistence.initializeWorkflow has set an active workflow", () => {
      const iframe = buildReadyIframe({
        extensionManager: {
          spinner: false,
          workflow: { activeWorkflow: null },
        },
      });
      expect(isIframeAppReady(iframe)).toBe(false);
    });

    it("returns false when only the early extensionManager.workflow stub is present", () => {
      // The lax check used to pass here, but at this point extensionManager
      // is set in App.vue script setup — before comfyApp.setup() runs.
      const iframe = buildIframeWithApp({
        handleFile: vi.fn(),
        extensionManager: {
          workflow: {},
        },
      });
      expect(isIframeAppReady(iframe)).toBe(false);
    });
  });
});
