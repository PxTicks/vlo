import { beforeEach, describe, expect, it, vi } from "vitest";
import * as comfyApi from "../services/comfyuiApi";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { createDefaultWorkflowRules } from "../services/workflowRules";
import type { Asset } from "../../../types/Asset";

const mocks = vi.hoisted(() => ({
  captureFramePngAtTick: vi.fn(),
  renderTimelineSelectionToWebm: vi.fn(),
  renderTimelineSelectionToWebmWithMask: vi.fn(),
}));

vi.mock("../utils/inputSelection", () => ({
  captureFramePngAtTick: mocks.captureFramePngAtTick,
  renderTimelineSelectionToWebm: mocks.renderTimelineSelectionToWebm,
  renderTimelineSelectionToWebmWithMask:
    mocks.renderTimelineSelectionToWebmWithMask,
}));

describe("useGenerationStore metadata replay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    useAssetStore.setState({ assets: [] });
    useGenerationStore.setState({
      editorRef: null,
      tempWorkflow: null,
      availableWorkflows: [],
      selectedWorkflowId: null,
      activeWorkflowRules: null,
      activeRulesWarnings: [],
      rulesWorkflowSourceId: null,
      syncedWorkflow: null,
      syncedGraphData: null,
      workflowInputs: [],
      mediaInputs: {},
      derivedMaskMappings: [],
      isWorkflowLoading: false,
      workflowLoadState: "idle",
      isWorkflowReady: false,
      workflowLoadError: null,
      workflowWarning: null,
      workflowRuleWarnings: [],
    });

    mocks.captureFramePngAtTick.mockResolvedValue(
      new File(["thumb"], "thumb.png", { type: "image/png" }),
    );
    mocks.renderTimelineSelectionToWebm.mockResolvedValue(
      new File(["video"], "selection.webm", { type: "video/webm" }),
    );
    mocks.renderTimelineSelectionToWebmWithMask.mockResolvedValue({
      video: new File(["video"], "selection.webm", { type: "video/webm" }),
      mask: new File(["mask"], "selection-mask.webm", {
        type: "video/webm",
      }),
    });
  });

  it("matches sidecar presentation from saved workflow graph data and restores asset inputs", async () => {
    const sourceAsset: Asset = {
      id: "source-asset",
      hash: "hash-source",
      name: "source.png",
      type: "image",
      src: "source.png",
      createdAt: Date.now(),
    };
    const generatedAsset: Asset = {
      id: "generated-asset",
      hash: "hash-generated",
      name: "generated.png",
      type: "image",
      src: "generated.png",
      createdAt: Date.now(),
      creationMetadata: {
        source: "generated",
        workflowName: "Original Workflow",
        inputs: [
          {
            nodeId: "145",
            kind: "draggedAsset",
            parentAssetId: sourceAsset.id,
          },
        ],
        comfyuiPrompt: {
          "145": {
            class_type: "LoadImage",
            inputs: { image: "source.png" },
          },
          "999": {
            class_type: "RuntimeOnlyNode",
            inputs: {},
          },
        },
        comfyuiWorkflow: {
          nodes: [{ id: 145, type: "LoadImage", widgets_values: ["source.png"] }],
        },
      },
    };

    useAssetStore.setState({ assets: [sourceAsset, generatedAsset] });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "wan2_2_flf2v.json", name: "Wan2.2 I2V & FLF2V" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      nodes: [{ id: 145, type: "LoadImage", widgets_values: ["other.png"] }],
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wan2_2_flf2v.json",
      has_sidecar: true,
      rules: createDefaultWorkflowRules({
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

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();
    const restoredInput = Object.values(state.mediaInputs)[0];

    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.workflowInputs[0]?.label).toBe("Source Image");
    expect(state.workflowInputs[0]?.origin).toBe("rule");
    expect(restoredInput).toMatchObject({
      kind: "asset",
      asset: { id: sourceAsset.id },
    });
  });

  it("restores prepared timeline selections so generation is immediately ready", async () => {
    const preparedVideoFile = new File(["video"], "selection.webm", {
      type: "video/webm",
    });
    const thumbnailFile = new File(["thumb"], "thumb.png", {
      type: "image/png",
    });
    const generatedAsset: Asset = {
      id: "generated-video",
      hash: "hash-generated-video",
      name: "generated-video.mp4",
      type: "video",
      src: "generated-video.mp4",
      createdAt: Date.now(),
      creationMetadata: {
        source: "generated",
        workflowName: "Original Workflow",
        inputs: [
          {
            nodeId: "145",
            kind: "timelineSelection",
            timelineSelection: {
              start: 10,
              end: 40,
              clips: [],
            },
          },
        ],
        comfyuiPrompt: {
          "145": {
            class_type: "LoadVideo",
            inputs: { video: "selection.webm" },
          },
        },
      },
    };

    mocks.captureFramePngAtTick.mockResolvedValue(thumbnailFile);
    mocks.renderTimelineSelectionToWebm.mockResolvedValue(preparedVideoFile);
    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([]);

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const restoredInput = Object.values(
      useGenerationStore.getState().mediaInputs,
    )[0];

    expect(restoredInput).toMatchObject({
      kind: "timelineSelection",
      isExtracting: false,
      preparedVideoFile,
      thumbnailFile,
    });
  });
});
