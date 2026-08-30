import { beforeEach, describe, expect, it, vi } from "vitest";
import * as comfyApi from "../services/comfyuiApi";
import { useGenerationStore } from "../useGenerationStore";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { createDefaultWorkflowRules } from "../services/workflowRules";
import type { Asset } from "../../../types/Asset";
import type { GenerationPanelSnapshot } from "../persistence/generationPanelSnapshot";

vi.mock("../services/workflowSyncController", () => ({
  injectWorkflowAndRead: vi.fn(),
  waitForAppReady: vi.fn(async () => true),
}));

const sourceAsset: Asset = {
  id: "source-asset",
  hash: "hash-source",
  name: "source.png",
  type: "image",
  src: "source.png",
  createdAt: Date.now(),
};

describe("useGenerationStore panel snapshot restore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAssetStore.setState({ assets: [sourceAsset] });
    useGenerationStore.setState({
      editorRef: null,
      availableWorkflows: [],
      selectedWorkflowId: null,
      activeWorkflowRules: null,
      syncedWorkflow: null,
      syncedGraphData: null,
      workflowInputs: [],
      mediaInputs: {},
      pendingReplayPanelState: null,
      pendingPanelSnapshot: null,
      targetResolution: 1080,
      targetResolutionIsCustom: false,
      workflowLoadState: "idle",
      workflowLoadError: null,
    });

    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      nodes: [{ id: 145, type: "LoadImage", widgets_values: ["other.png"] }],
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wan.json",
      has_sidecar: true,
      rules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            enabled: true,
            config: { resolutions: [480, 720, 1080] },
          },
        ],
        nodes: {
          "145": {
            present: {
              label: "Source Image",
              input_type: "image",
              param: "image",
              class_type: "LoadImage",
            },
          },
        },
      }),
      warnings: [],
    });
  });

  it("reopens on the saved workflow with its inputs and values", async () => {
    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "wan.json",
      targetResolution: 720,
      inputs: [
        { nodeId: "145", kind: "draggedAsset", parentAssetId: sourceAsset.id },
      ],
      replayState: {
        version: 2,
        textValues: { "6:text": "a cat" },
        widgetValues: { "3:seed": "42" },
        exactAspectRatio: true,
        aspectRatioSelection: "16:9",
      },
    };

    useGenerationStore.getState().setPendingPanelSnapshot(snapshot);
    await useGenerationStore.getState().restorePanelSnapshot(snapshot);

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("wan.json");
    // Consumed on restore, so a second mount cannot replay it over live edits.
    expect(state.pendingPanelSnapshot).toBeNull();
    expect(state.targetResolution).toBe(720);
    expect(state.exactAspectRatio).toBe(true);
    expect(state.aspectRatioSelection).toBe("16:9");
    expect(state.pendingReplayPanelState).toMatchObject({
      textValues: { "6:text": "a cat" },
      widgetValues: { "3:seed": "42" },
    });
    expect(state.mediaInputs["145:image"]).toMatchObject({
      kind: "asset",
      asset: { id: sourceAsset.id },
    });
  });

  it("keeps the saved state pending when the workflow cannot be loaded", async () => {
    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "deleted.json",
      inputs: [],
      replayState: { version: 2, textValues: { "6:text": "a cat" } },
    };
    vi.spyOn(comfyApi, "getWorkflowContent").mockRejectedValue(
      new Error("workflow not found"),
    );

    useGenerationStore.getState().setPendingPanelSnapshot(snapshot);
    await useGenerationStore.getState().restorePanelSnapshot(snapshot);

    const state = useGenerationStore.getState();
    // Still pending, so persistence keeps blocking writes: a workflow that
    // failed to load must not overwrite what the project has on disk.
    expect(state.pendingPanelSnapshot).toEqual(snapshot);
    expect(state.isRestoringPanelSnapshot).toBe(false);
  });

  it("drops the saved state once the user picks a workflow themselves", async () => {
    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "deleted.json",
      inputs: [],
    };
    useGenerationStore.getState().setPendingPanelSnapshot(snapshot);

    useGenerationStore.getState().discardPendingPanelSnapshot();

    expect(useGenerationStore.getState().pendingPanelSnapshot).toBeNull();
  });

  it("abandons a restore that a project change interrupted", async () => {
    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "wan.json",
      targetResolution: 720,
      inputs: [
        { nodeId: "145", kind: "draggedAsset", parentAssetId: sourceAsset.id },
      ],
      replayState: { version: 2, textValues: { "6:text": "a cat" } },
    };

    let releaseWorkflow: (() => void) | null = null;
    vi.spyOn(comfyApi, "getWorkflowContent").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseWorkflow = resolve;
      });
      return { nodes: [] };
    });

    const restore = useGenerationStore.getState().restorePanelSnapshot(snapshot);
    await vi.waitFor(() => expect(releaseWorkflow).not.toBeNull());

    // The user opened another project while ComfyUI was still answering.
    useGenerationStore.getState().clearPanelForProjectChange();
    releaseWorkflow!();
    await restore;

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBeNull();
    expect(state.pendingReplayPanelState).toBeNull();
    expect(state.mediaInputs).toEqual({});
    // The interrupted workflow load is stale too, so it cannot repopulate the
    // panel behind the new project.
    expect(state.syncedGraphData).toBeNull();
    expect(state.workflowInputs).toEqual([]);
  });

  it("resets the panel for the incoming project", () => {
    useGenerationStore.setState({
      selectedWorkflowId: "wan.json",
      workflowInputs: [
        {
          id: "6:text",
          nodeId: "6",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "",
          origin: "rule",
        },
      ],
      targetResolution: 480,
      exactAspectRatio: true,
    });
    const resetTokenBefore = useGenerationStore.getState().panelResetToken;

    useGenerationStore.getState().clearPanelForProjectChange();

    const state = useGenerationStore.getState();
    // Nothing of the outgoing project survives to be written into the next one.
    expect(state.selectedWorkflowId).toBeNull();
    expect(state.workflowInputs).toEqual([]);
    expect(state.exactAspectRatio).toBe(false);
    expect(state.targetResolution).not.toBe(480);
    expect(state.panelResetToken).toBe(resetTokenBefore + 1);
  });

  it("waits for an asset the project has not hydrated yet", async () => {
    const lateAsset: Asset = { ...sourceAsset, id: "late-asset" };
    useAssetStore.setState({ assets: [] });

    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "wan.json",
      inputs: [
        { nodeId: "145", kind: "draggedAsset", parentAssetId: lateAsset.id },
      ],
    };

    const restore = useGenerationStore.getState().restorePanelSnapshot(snapshot);
    setTimeout(() => useAssetStore.setState({ assets: [lateAsset] }), 30);
    await restore;

    expect(useGenerationStore.getState().mediaInputs["145:image"]).toMatchObject(
      { kind: "asset", asset: { id: lateAsset.id } },
    );
  });

  it("leaves the panel alone when another workflow was selected meanwhile", async () => {
    const snapshot: GenerationPanelSnapshot = {
      version: 1,
      workflowId: "wan.json",
      inputs: [],
      replayState: { version: 2, textValues: { "6:text": "a cat" } },
    };

    vi.spyOn(comfyApi, "getWorkflowContent").mockImplementation(async () => {
      useGenerationStore.setState({ selectedWorkflowId: "user-picked.json" });
      return { nodes: [] };
    });

    await useGenerationStore.getState().restorePanelSnapshot(snapshot);

    expect(useGenerationStore.getState().pendingReplayPanelState).toBeNull();
  });
});
