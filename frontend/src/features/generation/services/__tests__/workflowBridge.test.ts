import { describe, expect, it, vi } from "vitest";
import {
  buildWorkflowResultFromGraphData,
  capturePendingWarningsForWorkflowFromIframe,
  clearPendingWarningsFromIframe,
  isIframeAppReady,
  isIframeBackendConnected,
  loadWorkflowIntoIframe,
  parseInputsFromGraphData,
  readAndClearPendingWarningsFromIframe,
  readActiveWorkflowFromIframe,
  readPendingWarningsFromIframe,
  refreshMissingModelsInIframe,
} from "../workflowBridge";

type ReadyAppOverrides = {
  handleFile?: unknown;
  canvas?: unknown;
  extensionManager?: unknown;
  refreshMissingModels?: unknown;
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

  describe("active workflow reading", () => {
    it("returns null for missing graph state and clones valid state", () => {
      expect(readActiveWorkflowFromIframe(buildIframeWithApp(null))).toBeNull();
      const activeState = { nodes: [{ id: 1 }], links: [] };
      const iframe = buildIframeWithApp({
        extensionManager: {
          workflow: {
            activeWorkflow: {
              fullFilename: "/nested/full.json",
              activeState,
            },
          },
        },
      });
      const result = readActiveWorkflowFromIframe(iframe);
      expect(result).toEqual({
        graphData: activeState,
        filename: "full.json",
        isModified: false,
      });
      expect(result?.graphData).not.toBe(activeState);
    });

    it("falls back to a shallow clone if structuredClone fails", () => {
      const original = globalThis.structuredClone;
      globalThis.structuredClone = vi.fn(() => {
        throw new Error("not cloneable");
      });
      const state = { nodes: [], custom: true };
      const result = readActiveWorkflowFromIframe(
        buildIframeWithApp({
          extensionManager: {
            workflow: {
              activeWorkflow: { key: "key.json", activeState: state },
            },
          },
        }),
      );
      expect(result?.graphData).toEqual(state);
      globalThis.structuredClone = original;
    });

    it("handles inaccessible iframe internals", () => {
      const iframe = {} as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross origin");
        },
      });
      expect(readActiveWorkflowFromIframe(iframe)).toBeNull();
    });
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

    it("normalizes, deduplicates, and clears mixed warning shapes", () => {
      const iframe = buildIframeWithPendingWarnings({
        missingNodeTypes: [
          " MissingNode ",
          { type: "MissingNode" },
          { class_type: "OtherNode" },
          "",
          null,
        ],
        missingModels: [
          " model.safetensors ",
          { file_name: "file.bin" },
          { filename: "filename.bin" },
          { url: "https://models.test/model" },
          { hash: "abc123" },
          { name: "" },
          null,
        ],
      });
      expect(readAndClearPendingWarningsFromIframe(iframe)).toEqual({
        missingNodeTypes: ["MissingNode", "OtherNode"],
        missingModels: [
          "model.safetensors",
          "file.bin",
          "filename.bin",
          "https://models.test/model",
          "abc123",
        ],
      });
      expect(readPendingWarningsFromIframe(iframe)).toBeNull();
    });

    it("returns null for empty parsed warnings and reports clear availability", () => {
      const iframe = buildIframeWithPendingWarnings({
        missingNodeTypes: "bad",
        missingModels: { missingModels: [] },
      });
      expect(readPendingWarningsFromIframe(iframe)).toBeNull();
      expect(clearPendingWarningsFromIframe(iframe)).toBe(true);
      expect(clearPendingWarningsFromIframe(buildIframeWithApp(null))).toBe(false);
    });

    it("handles inaccessible warning state", () => {
      const iframe = {} as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross origin");
        },
      });
      expect(readPendingWarningsFromIframe(iframe)).toBeNull();
      expect(clearPendingWarningsFromIframe(iframe)).toBe(false);
    });
  });

  describe("warning refresh and capture", () => {
    it("refreshes missing models when the iframe API supports it", async () => {
      const refreshMissingModels = vi.fn().mockResolvedValue(undefined);
      const iframe = buildIframeWithApp({ refreshMissingModels });
      await expect(refreshMissingModelsInIframe(iframe)).resolves.toBe(true);
      expect(refreshMissingModels).toHaveBeenCalledWith({ silent: true });
      await expect(
        refreshMissingModelsInIframe(buildIframeWithApp({})),
      ).resolves.toBe(false);
    });

    it("returns false when refresh fails", async () => {
      const iframe = buildIframeWithApp({
        refreshMissingModels: vi.fn().mockRejectedValue(new Error("offline")),
      });
      await expect(refreshMissingModelsInIframe(iframe)).resolves.toBe(false);
    });

    it("captures warnings from filename and graph matches, clearing the source", async () => {
      const workflow = {
        filename: "/workflows/target.json",
        activeState: { nodes: [{ id: 1, type: "LoadImage" }], links: [] },
        pendingWarnings: {
          missingNodeTypes: ["Missing"],
        },
      };
      const iframe = buildIframeWithApp({
        extensionManager: {
          workflow: {
            workflows: [workflow],
            activeWorkflow: workflow,
          },
        },
      });
      await expect(
        capturePendingWarningsForWorkflowFromIframe(
          iframe,
          { nodes: [{ id: 1, type: "LoadImage" }], links: [] },
          "target.json",
          10,
        ),
      ).resolves.toEqual({
        missingNodeTypes: ["Missing"],
        missingModels: [],
      });
      expect(workflow.pendingWarnings).toBeNull();
    });

    it("settles with null for a matching workflow without warnings or timeout", async () => {
      const workflow = {
        path: "target.json",
        activeState: { nodes: [{ id: 1, type: "Node" }], links: [] },
      };
      const iframe = buildIframeWithApp({
        extensionManager: {
          workflow: {
            openWorkflows: [workflow],
            activeWorkflow: workflow,
          },
        },
      });
      await expect(
        capturePendingWarningsForWorkflowFromIframe(
          iframe,
          workflow.activeState,
          "target.json",
          10,
          0,
        ),
      ).resolves.toBeNull();
      await expect(
        capturePendingWarningsForWorkflowFromIframe(
          buildIframeWithApp({}),
          workflow.activeState,
          "target.json",
          0,
        ),
      ).resolves.toBeNull();
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

    it("returns false without handleFile and on handleFile failure", async () => {
      await expect(
        loadWorkflowIntoIframe(buildIframeWithApp({}), { nodes: [] }),
      ).resolves.toEqual({ ok: false, warnings: null });
      await expect(
        loadWorkflowIntoIframe(
          buildIframeWithApp({
            handleFile: vi.fn().mockRejectedValue(new Error("load failed")),
          }),
          { nodes: [] },
        ),
      ).resolves.toEqual({ ok: false, warnings: null });
    });

    it("passes filename and warning options to handleFile", async () => {
      const handleFile = vi.fn().mockResolvedValue(undefined);
      const iframe = buildIframeWithApp({ handleFile });
      await expect(
        loadWorkflowIntoIframe(
          iframe,
          { nodes: [{ id: 1 }] },
          "custom.json",
          { deferWarnings: false },
        ),
      ).resolves.toEqual({ ok: true, warnings: null });
      const [file, source, options] = handleFile.mock.calls[0];
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("custom.json");
      expect(source).toBeUndefined();
      expect(options).toEqual({ deferWarnings: false });
    });

    it("keeps one matched tab and tolerates close failures", async () => {
      const old = {
        filename: "old.json",
        activeState: { nodes: [{ id: 1, type: "Old" }] },
      };
      const target = {
        filename: "target.json",
        activeState: { nodes: [{ id: 2, type: "Target" }] },
      };
      const closeWorkflow = vi.fn().mockRejectedValue(new Error("cannot close"));
      const iframe = buildIframeWithApp({
        handleFile: vi.fn().mockResolvedValue(undefined),
        extensionManager: {
          workflow: {
            workflows: [old, target],
            activeWorkflow: old,
            closeWorkflow,
          },
        },
      });
      await expect(
        loadWorkflowIntoIframe(
          iframe,
          { nodes: [{ id: 2, type: "Target" }] },
          "target.json",
        ),
      ).resolves.toEqual({ ok: true, warnings: null });
      expect(closeWorkflow).toHaveBeenCalledWith(old);
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

    it("returns false without handleFile or extension manager and on access failure", () => {
      expect(
        isIframeAppReady(
          buildReadyIframe({
            handleFile: null,
          }),
        ),
      ).toBe(false);
      expect(
        isIframeAppReady(
          buildReadyIframe({
            extensionManager: undefined,
          }),
        ),
      ).toBe(false);
      const iframe = {} as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross origin");
        },
      });
      expect(isIframeAppReady(iframe)).toBe(false);
    });
  });

  describe("isIframeBackendConnected", () => {
    it("falls back to app readiness when no socket is exposed", () => {
      expect(isIframeBackendConnected(buildReadyIframe())).toBe(true);
      expect(isIframeBackendConnected(buildIframeWithApp(null))).toBe(false);
    });

    it("uses connected flags and ready-state constants across socket locations", () => {
      const connected = buildReadyIframe();
      (
        connected.contentWindow as unknown as {
          app: ReadyAppOverrides & { api: unknown };
        }
      ).app.api = { socket: { connected: true } };
      expect(isIframeBackendConnected(connected)).toBe(true);

      const disconnected = buildReadyIframe();
      (
        disconnected.contentWindow as unknown as {
          api: unknown;
        }
      ).api = { socket: { connected: false } };
      expect(isIframeBackendConnected(disconnected)).toBe(false);

      const open = buildReadyIframe();
      (
        open.contentWindow as unknown as {
          api: unknown;
        }
      ).api = { socket: { readyState: 7, OPEN: 7 } };
      expect(isIframeBackendConnected(open)).toBe(true);

      const invalid = buildReadyIframe();
      (
        invalid.contentWindow as unknown as {
          api: unknown;
        }
      ).api = { socket: { readyState: "open" } };
      expect(isIframeBackendConnected(invalid)).toBe(false);
    });

    it("handles a missing window and inaccessible iframe", () => {
      expect(
        isIframeBackendConnected({
          contentWindow: null,
        } as unknown as HTMLIFrameElement),
      ).toBe(false);
      const iframe = {} as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross origin");
        },
      });
      expect(isIframeBackendConnected(iframe)).toBe(false);
    });
  });
});
