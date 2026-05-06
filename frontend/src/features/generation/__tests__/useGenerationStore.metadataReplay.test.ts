import { beforeEach, describe, expect, it, vi } from "vitest";
import * as comfyApi from "../services/comfyuiApi";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { createDefaultWorkflowRules } from "../services/workflowRules";
import type { Asset } from "../../../types/Asset";

const mocks = vi.hoisted(() => ({
  captureFramePngAtTick: vi.fn(),
  renderTimelineSelectionToMp4: vi.fn(),
  renderTimelineSelectionToMp4WithDerivedMasks: vi.fn(),
  pickPrimaryPreparedMaskFile: vi.fn(),
  extractAudioFromSelection: vi.fn(),
  createAudioSelectionPlaceholderFile: vi.fn(),
  injectWorkflowAndRead: vi.fn(),
}));

vi.mock("../utils/inputSelection", () => ({
  captureFramePngAtTick: mocks.captureFramePngAtTick,
  renderTimelineSelectionToMp4: mocks.renderTimelineSelectionToMp4,
  renderTimelineSelectionToMp4WithDerivedMasks:
    mocks.renderTimelineSelectionToMp4WithDerivedMasks,
  pickPrimaryPreparedMaskFile: mocks.pickPrimaryPreparedMaskFile,
}));

vi.mock("../utils/manualSlotMedia", () => ({
  extractAudioFromSelection: mocks.extractAudioFromSelection,
  createAudioSelectionPlaceholderFile: mocks.createAudioSelectionPlaceholderFile,
}));

vi.mock("../services/workflowSyncController", () => ({
  injectWorkflowAndRead: mocks.injectWorkflowAndRead,
}));

function makeReadyEditorRef(): HTMLIFrameElement {
  return {
    contentWindow: {
      app: {
        handleFile: vi.fn(),
        extensionManager: {
          workflow: {},
        },
      },
    },
  } as unknown as HTMLIFrameElement;
}

describe("useGenerationStore metadata replay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.captureFramePngAtTick.mockReset();
    mocks.renderTimelineSelectionToMp4.mockReset();
    mocks.renderTimelineSelectionToMp4WithDerivedMasks.mockReset();
    mocks.pickPrimaryPreparedMaskFile.mockReset();
    mocks.extractAudioFromSelection.mockReset();
    mocks.createAudioSelectionPlaceholderFile.mockReset();
    mocks.injectWorkflowAndRead.mockReset();

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
      pendingReplayPanelState: null,
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
    mocks.renderTimelineSelectionToMp4.mockResolvedValue(
      new File(["video"], "selection.mp4", { type: "video/mp4" }),
    );
    mocks.renderTimelineSelectionToMp4WithDerivedMasks.mockResolvedValue({
      video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
      masks: {
        video_binary: new File(["mask"], "selection-mask.mp4", {
          type: "video/mp4",
        }),
      },
      maskContentByKey: {
        video_binary: true,
      },
    });
    mocks.pickPrimaryPreparedMaskFile.mockReturnValue(
      new File(["mask"], "selection-mask.mp4", {
        type: "video/mp4",
      }),
    );
    mocks.extractAudioFromSelection.mockResolvedValue(
      new File(["audio"], "selection.wav", { type: "audio/wav" }),
    );
    mocks.createAudioSelectionPlaceholderFile.mockImplementation(
      () =>
        new File(
          ["audio-selection-thumbnail-placeholder"],
          "generation-audio-selection-placeholder.txt",
          { type: "text/plain" },
        ),
    );
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
        targetResolution: 720,
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

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();
    const restoredInput = Object.values(state.mediaInputs)[0];

    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.targetResolution).toBe(720);
    expect(state.workflowInputs[0]?.label).toBe("Source Image");
    expect(state.workflowInputs[0]?.origin).toBe("rule");
    expect(restoredInput).toMatchObject({
      kind: "asset",
      asset: { id: sourceAsset.id },
    });
  });

  it("clears stale media slots before restoring regenerate metadata", async () => {
    const sourceAsset: Asset = {
      id: "source-asset",
      hash: "hash-source",
      name: "source.png",
      type: "image",
      src: "source.png",
      createdAt: Date.now(),
    };
    const staleStartAsset: Asset = {
      id: "stale-start",
      hash: "hash-stale-start",
      name: "stale-start.png",
      type: "image",
      src: "stale-start.png",
      createdAt: Date.now(),
    };
    const staleEndAsset: Asset = {
      id: "stale-end",
      hash: "hash-stale-end",
      name: "stale-end.png",
      type: "image",
      src: "stale-end.png",
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
        workflowSourceId: "wan2_2_flf2v.json",
        inputs: [
          {
            nodeId: "62",
            kind: "draggedAsset",
            parentAssetId: sourceAsset.id,
          },
        ],
        replayState: {
          version: 1,
          workflowSourceId: "wan2_2_flf2v.json",
          workflowInputs: [
            {
              nodeId: "62",
              classType: "LoadImage",
              inputType: "image",
              param: "image",
              label: "Start Frame",
              origin: "rule",
            },
            {
              nodeId: "68",
              classType: "LoadImage",
              inputType: "image",
              param: "image",
              label: "End Frame",
              origin: "rule",
            },
          ],
        },
        comfyuiPrompt: {
          "62": {
            class_type: "LoadImage",
            inputs: { image: "source.png" },
          },
          "68": {
            class_type: "LoadImage",
            inputs: { image: "unused.png" },
          },
        },
        comfyuiWorkflow: {
          nodes: [
            { id: 62, type: "LoadImage", widgets_values: ["source.png"] },
            { id: 68, type: "LoadImage", widgets_values: ["unused.png"] },
          ],
        },
      },
    };

    useAssetStore.setState({
      assets: [sourceAsset, staleStartAsset, staleEndAsset, generatedAsset],
    });
    useGenerationStore.setState({
      workflowInputs: [
        {
          nodeId: "62",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Start Frame",
          currentValue: null,
          origin: "rule",
        },
        {
          nodeId: "68",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "End Frame",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {
        "62:image": {
          kind: "asset",
          asset: staleStartAsset,
        },
        "68:image": {
          kind: "asset",
          asset: staleEndAsset,
        },
      },
    });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "wan2_2_flf2v.json", name: "Wan2.2 I2V & FLF2V" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wan2_2_flf2v.json",
      has_sidecar: true,
      rules: createDefaultWorkflowRules(),
      warnings: [],
    });

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();
    expect(Object.keys(state.mediaInputs)).toEqual(["62:image"]);
    expect(state.mediaInputs["62:image"]).toMatchObject({
      kind: "asset",
      asset: { id: sourceAsset.id },
    });
    expect(state.mediaInputs["68:image"]).toBeUndefined();
  });

  it("prefers the saved visual workflow snapshot and replay state when restoring a generated workflow", async () => {
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
        workflowSourceId: "wan2_2_flf2v.json",
        targetResolution: 720,
        inputs: [
          {
            nodeId: "145",
            kind: "draggedAsset",
            parentAssetId: sourceAsset.id,
          },
        ],
        replayState: {
          version: 1,
          workflowSourceId: "wan2_2_flf2v.json",
          workflowInputs: [
            {
              nodeId: "145",
              classType: "LoadImage",
              inputType: "image",
              param: "image",
              label: "Replay Source Image",
              origin: "rule",
            },
          ],
          textValues: {
            "6:text": "hello from replay",
          },
          widgetValues: {
            widget_145_strength_model: "0.5",
          },
          widgetModes: {
            widget_mode_145_seed: "randomize",
          },
          derivedWidgetValues: {
            derived_widget_dual_sampler_denoise: "0.4",
          },
          exactAspectRatio: true,
          maskCropMode: "full",
          maskCropDilation: 0.2,
        },
        comfyuiPrompt: {
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
    const getWorkflowContentSpy = vi
      .spyOn(comfyApi, "getWorkflowContent")
      .mockResolvedValue({
        nodes: [
          { id: 62, type: "LoadImage", widgets_values: ["source.png"] },
          { id: 68, type: "LoadImage", widgets_values: ["example.png"] },
        ],
      });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wan2_2_flf2v.json",
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

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();

    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.targetResolution).toBe(720);
    expect(state.exactAspectRatio).toBe(true);
    expect(state.maskCropMode).toBe("full");
    expect(state.maskCropDilation).toBe(0.2);
    expect(state.workflowInputs[0]?.label).toBe("Source Image");
    expect(state.syncedGraphData).toEqual({
      nodes: [{ id: 145, type: "LoadImage", widgets_values: ["source.png"] }],
    });
    expect(state.pendingReplayPanelState).toEqual({
      textValues: {
        "6:text": "hello from replay",
      },
      widgetValues: {
        widget_145_strength_model: "0.5",
      },
      widgetModes: {
        widget_mode_145_seed: "randomize",
      },
        derivedWidgetValues: {
          derived_widget_dual_sampler_denoise: "0.4",
        },
    });
    expect(getWorkflowContentSpy).not.toHaveBeenCalled();
  });

  it("keeps replayed workflows temporary when the iframe sync reports a synthetic temp filename", async () => {
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
        workflowSourceId: "wan2_2_flf2v.json",
        targetResolution: 720,
        inputs: [],
        replayState: {
          version: 1,
          workflowSourceId: "wan2_2_flf2v.json",
          workflowInputs: [
            {
              nodeId: "68",
              classType: "LoadImage",
              inputType: "image",
              param: "image",
              label: "Start Frame",
              origin: "rule",
            },
          ],
        },
        comfyuiPrompt: {
          "67": {
            class_type: "WanFirstLastFrameToVideo",
            inputs: {},
          },
        },
        comfyuiWorkflow: {
          nodes: [{ id: 67, type: "WanFirstLastFrameToVideo" }],
        },
      },
    };

    useGenerationStore.setState({
      editorRef: makeReadyEditorRef(),
    });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "wan2_2_flf2v.json", name: "Wan2.2 I2V & FLF2V" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wan2_2_flf2v.json",
      has_sidecar: true,
      rules: createDefaultWorkflowRules({
        nodes: {
          "68": {
            present: {
              label: "Start Frame",
              input_type: "image",
              param: "image",
              class_type: "LoadImage",
              required: false,
            },
          },
        },
      }),
      warnings: [],
    });
    mocks.injectWorkflowAndRead.mockResolvedValue({
      ok: true,
      deferred: false,
      reason: null,
      warnings: null,
      workflowResult: {
        workflow: {
          "68": {
            class_type: "LoadImage",
            inputs: { image: "example.png" },
          },
          "67": {
            class_type: "WanFirstLastFrameToVideo",
            inputs: { start_image: ["68", 0] },
          },
        },
        graphData: {
          nodes: [
            { id: 68, type: "LoadImage", widgets_values: ["example.png"] },
            { id: 67, type: "WanFirstLastFrameToVideo" },
          ],
        },
        inputs: [
          {
            nodeId: "68",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Start Frame",
            currentValue: "example.png",
            origin: "inferred",
          },
        ],
        filename: "__temp__.json",
      },
    });

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.tempWorkflow?.rulesSourceId).toBe("wan2_2_flf2v.json");
  });

  it("clamps a saved target resolution to the closest supported workflow value", async () => {
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
        targetResolution: 900,
        inputs: [],
        comfyuiPrompt: {
          "145": {
            class_type: "LoadImage",
            inputs: { image: "source.png" },
          },
        },
        comfyuiWorkflow: {
          nodes: [{ id: 145, type: "LoadImage", widgets_values: ["source.png"] }],
        },
      },
    };

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
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              resolutions: [720, 1080],
            },
            targets: [],
          },
        ],
      }),
      warnings: [],
    });

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    expect(useGenerationStore.getState().targetResolution).toBe(720);
  });

  it("restores prepared timeline selections so generation is immediately ready", async () => {
    const preparedVideoFile = new File(["video"], "selection.mp4", {
      type: "video/mp4",
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
            inputs: { video: "selection.mp4" },
          },
        },
      },
    };

    mocks.captureFramePngAtTick.mockResolvedValue(thumbnailFile);
    mocks.renderTimelineSelectionToMp4.mockResolvedValue(preparedVideoFile);
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

  it("restores image timeline selections as frame captures", async () => {
    const restoredFrame = new File(["frame"], "frame.png", {
      type: "image/png",
    });
    const generatedAsset: Asset = {
      id: "generated-image",
      hash: "hash-generated-image",
      name: "generated-image.png",
      type: "image",
      src: "generated-image.png",
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
              clips: [],
              fps: 24,
            },
          },
        ],
        replayState: {
          version: 1,
          workflowInputs: [
            {
              nodeId: "145",
              classType: "LoadImage",
              inputType: "image",
              param: "image",
              label: "Start Frame",
              origin: "rule",
            },
          ],
        },
        comfyuiPrompt: {
          "145": {
            class_type: "LoadImage",
            inputs: { image: "frame.png" },
          },
        },
      },
    };

    mocks.captureFramePngAtTick.mockResolvedValue(restoredFrame);
    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([]);

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const restoredInput = Object.values(
      useGenerationStore.getState().mediaInputs,
    )[0];

    expect(restoredInput).toMatchObject({
      kind: "frame",
      file: restoredFrame,
      timelineSelection: {
        start: 10,
        clips: [],
        fps: 24,
      },
    });
  });

  it("restores audio timeline selections with extracted audio files", async () => {
    const preparedAudioFile = new File(["audio"], "selection.wav", {
      type: "audio/wav",
    });
    const placeholderFile = new File(
      ["audio-selection-thumbnail-placeholder"],
      "generation-audio-selection-placeholder.txt",
      { type: "text/plain" },
    );
    const generatedAsset: Asset = {
      id: "generated-audio",
      hash: "hash-generated-audio",
      name: "generated-audio.wav",
      type: "audio",
      src: "generated-audio.wav",
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
        replayState: {
          version: 1,
          workflowInputs: [
            {
              nodeId: "145",
              classType: "LoadAudio",
              inputType: "audio",
              param: "audio",
              label: "Audio Input",
              origin: "rule",
            },
          ],
        },
        comfyuiPrompt: {
          "145": {
            class_type: "LoadAudio",
            inputs: { audio: "selection.wav" },
          },
        },
      },
    };

    mocks.createAudioSelectionPlaceholderFile.mockReturnValue(placeholderFile);
    mocks.extractAudioFromSelection.mockResolvedValue(preparedAudioFile);
    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([]);

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const restoredInput = Object.values(
      useGenerationStore.getState().mediaInputs,
    )[0];

    expect(mocks.captureFramePngAtTick).not.toHaveBeenCalled();
    expect(mocks.extractAudioFromSelection).toHaveBeenCalledWith(
      {
        start: 10,
        end: 40,
        clips: [],
      },
      { exportFps: undefined },
    );
    expect(restoredInput).toMatchObject({
      kind: "timelineSelection",
      mediaType: "audio",
      isExtracting: false,
      preparedAudioFile,
      thumbnailFile: placeholderFile,
    });
  });

  it("sanitizes malformed saved timeline selections before audio replay", async () => {
    const preparedAudioFile = new File(["audio"], "selection.wav", {
      type: "audio/wav",
    });
    const placeholderFile = new File(
      ["audio-selection-thumbnail-placeholder"],
      "generation-audio-selection-placeholder.txt",
      { type: "text/plain" },
    );
    const generatedAsset: Asset = {
      id: "generated-audio-corrupt",
      hash: "hash-generated-audio-corrupt",
      name: "generated-audio.wav",
      type: "audio",
      src: "generated-audio.wav",
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
              clips: [null as unknown as never],
            },
          },
        ],
        replayState: {
          version: 1,
          workflowInputs: [
            {
              nodeId: "145",
              classType: "LoadAudio",
              inputType: "audio",
              param: "audio",
              label: "Audio Input",
              origin: "rule",
            },
          ],
        },
        comfyuiPrompt: {
          "145": {
            class_type: "LoadAudio",
            inputs: { audio: "selection.wav" },
          },
        },
      },
    };

    mocks.createAudioSelectionPlaceholderFile.mockReturnValue(placeholderFile);
    mocks.extractAudioFromSelection.mockResolvedValue(preparedAudioFile);
    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([]);

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    expect(mocks.extractAudioFromSelection).toHaveBeenCalledWith(
      {
        start: 10,
        end: 40,
        clips: [],
      },
      { exportFps: undefined },
    );
  });

  it("falls back to the saved workflow name when no workflow snapshot is stored", async () => {
    const sourceAsset: Asset = {
      id: "source-asset",
      hash: "hash-source",
      name: "source.png",
      type: "image",
      src: "source.png",
      createdAt: Date.now(),
    };
    const graphData = {
      nodes: [{ id: 145, type: "LoadImage", widgets_values: ["source.png"] }],
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
        targetResolution: 720,
        inputs: [
          {
            nodeId: "145",
            kind: "draggedAsset",
            parentAssetId: sourceAsset.id,
          },
        ],
      },
    };

    useAssetStore.setState({ assets: [sourceAsset, generatedAsset] });
    useGenerationStore.setState({
      editorRef: makeReadyEditorRef(),
    });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "original_workflow.json", name: "Original Workflow" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue(graphData);
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "original_workflow.json",
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
    mocks.injectWorkflowAndRead.mockResolvedValue({
      ok: true,
      deferred: false,
      reason: null,
      warnings: null,
      workflowResult: {
        workflow: {
          "145": {
            class_type: "LoadImage",
            inputs: { image: "source.png" },
          },
        },
        graphData,
        inputs: [
          {
            nodeId: "145",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Source Image",
            currentValue: "source.png",
            origin: "inferred",
          },
        ],
        filename: "original_workflow.json",
      },
    });

    await useGenerationStore
      .getState()
      .loadWorkflowFromAssetMetadata(generatedAsset);

    const state = useGenerationStore.getState();
    const restoredInput = Object.values(state.mediaInputs)[0];

    expect(state.selectedWorkflowId).toBe("original_workflow.json");
    expect(state.rulesWorkflowSourceId).toBe("original_workflow.json");
    expect(state.targetResolution).toBe(720);
    expect(mocks.injectWorkflowAndRead).toHaveBeenCalledWith(
      state.editorRef,
      graphData,
      "original_workflow.json",
      expect.any(Function),
      null,
      null,
    );
    expect(restoredInput).toMatchObject({
      kind: "asset",
      asset: { id: sourceAsset.id },
    });
  });
});
