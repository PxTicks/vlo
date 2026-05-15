import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import type { WorkflowInput } from "../types";
import * as comfyApi from "../services/comfyuiApi";
import type { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import type { GenerationJob } from "../types";
import {
  createDefaultWorkflowRules,
  type WorkflowRules,
} from "../services/workflowRules";
import { useProjectStore } from "../../project";

const { mockGetRuntimeStatus } = vi.hoisted(() => ({
  mockGetRuntimeStatus: vi.fn(),
}));

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeStatus: mockGetRuntimeStatus,
}));

function makeTempInputs(): WorkflowInput[] {
  return [
    {
      nodeId: "145",
      classType: "LoadVideo",
      inputType: "video",
      param: "file",
      label: "Load Video",
      currentValue: "clip.mp4",
      origin: "inferred",
    },
  ];
}

function makeRunningJob(id: string): GenerationJob {
  return {
    id,
    status: "running",
    progress: 42,
    currentNode: "node_1",
    outputs: [],
    error: null,
    submittedAt: Date.now() - 1_000,
    completedAt: null,
  };
}

function makeWorkflowRules(
  overrides: Partial<WorkflowRules> = {},
): WorkflowRules {
  return createDefaultWorkflowRules(overrides);
}

describe("useGenerationStore workflow rules", () => {
  beforeEach(() => {
    mockGetRuntimeStatus.mockReset();
    mockGetRuntimeStatus.mockResolvedValue({
      backend: {
        status: "ok",
        mode: "development",
        frontendBuildPresent: false,
      },
      comfyui: {
        status: "connected",
        url: "http://localhost:8188",
        error: null,
      },
      sam2: {
        status: "available",
        error: null,
      },
    });
    vi.spyOn(comfyApi, "syncObjectInfo").mockResolvedValue({
      synced: true,
      node_classes: 0,
      input_node_map: {},
    });

    useProjectStore.setState({
      project: {
        id: "project-1",
        title: "Project One",
        createdAt: Date.now(),
        lastModified: Date.now(),
        rootAssetsFolder: "project-one",
      },
      config: {
        aspectRatio: "16:9",
        fps: 30,
        fitMode: "cover",
        layoutMode: "compact",
        assetBrowserDisplay: "grouped",
      },
    });

    useGenerationStore.setState({
      editorRef: null,
      // Tests don't mount the ComfyUI iframe, so disable the
      // graphToPrompt-based submission capture and let the dispatch fall
      // back to the workflow already on the plan. Production code keeps
      // this enabled so submissions always go through graphToPrompt.
      preResolvedPromptEnabled: false,
      connectionStatus: "connected",
      runtimeStatus: {
        backend: {
          status: "ok",
          mode: "development",
          frontendBuildPresent: false,
        },
        comfyui: {
          status: "connected",
          url: "http://localhost:8188",
          error: null,
        },
        sam2: {
          status: "available",
          error: null,
        },
      },
      runtimeStatusError: null,
      syncedWorkflow: null,
      syncedGraphData: null,
      workflowInputs: [],
      selectedWorkflowId: null,
      workflowLoadError: null,
      mediaInputs: {},
      pipelineStatus: {
        phase: "idle",
        message: null,
        interruptible: false,
      },
      pipelineRunToken: 0,
      preprocessAbortController: null,
      workflowRuleWarnings: [],
      activeRulesWarnings: [
        {
          code: "rule_loaded",
          message: "rules loaded",
        },
      ],
      activeWorkflowRules: makeWorkflowRules({
        nodes: {
          "145": {
            present: {
              label: "Control Video",
              input_type: "video",
              param: "file",
              class_type: "LoadVideo",
            },
          },
        },
      }),
      rulesWorkflowSourceId: "video_wan_vace_14B_v2v.json",
      tempWorkflow: {
        workflow: {
          "145": { class_type: "LoadVideo", inputs: { file: "clip.mp4" } },
        },
        graphData: { nodes: [] },
        inputs: makeTempInputs(),
      },
      jobs: new Map(),
      activeJobId: null,
      previewAnimation: null,
      generationQueue: [],
      postprocessingJobIds: [],
      targetResolution: 1080,
      maskCropMode: "crop",
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inherits source workflow rules for temp workflow", async () => {
    await useGenerationStore.getState().loadWorkflow(TEMP_WORKFLOW_ID);

    const state = useGenerationStore.getState();
    expect(state.rulesWorkflowSourceId).toBe("video_wan_vace_14B_v2v.json");
    expect(state.workflowInputs).toHaveLength(1);
    expect(state.workflowInputs[0].label).toBe("Control Video");
    expect(state.workflowInputs[0].origin).toBe("rule");
    expect(state.hasInferredInputs).toBe(false);
  });

  it("normalizes generation resolution to the closest workflow-supported value", async () => {
    useGenerationStore.setState({
      activeWorkflowRules: makeWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              stride: 16,
              search_steps: 2,
              resolutions: [480, 720],
              postprocess: {
                enabled: true,
                mode: "stretch_exact",
                apply_to: "all_visual_outputs",
              },
            },
            targets: [],
          },
        ],
      }),
    });

    await useGenerationStore.getState().loadWorkflow(TEMP_WORKFLOW_ID);

    expect(useGenerationStore.getState().targetResolution).toBe(720);
  });

  it("marks workflow as loading immediately when switching workflows", async () => {
    let resolveGraph: (value: Record<string, unknown>) => void = () => {};
    const graphPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveGraph = (value) => resolve(value);
    });

    vi.spyOn(comfyApi, "getWorkflowContent").mockReturnValue(graphPromise);
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      has_sidecar: true,
      rules: makeWorkflowRules(),
      warnings: [],
    });

    const loadPromise = useGenerationStore.getState().loadWorkflow("wf.json");
    const immediate = useGenerationStore.getState();
    expect(immediate.isWorkflowLoading).toBe(true);
    expect(immediate.workflowLoadState).toBe("loading");
    expect(immediate.isWorkflowReady).toBe(false);

    resolveGraph({});
    await loadPromise;
  });

  it("does not request an editor reconnect when runtime recovers and the editor is healthy", async () => {
    useGenerationStore.setState((state) => ({
      connectionStatus: "disconnected",
      editorNeedsReconnect: false,
      editorReconnectSignal: 0,
      runtimeStatus: state.runtimeStatus
        ? {
            ...state.runtimeStatus,
            comfyui: {
              ...state.runtimeStatus.comfyui,
              status: "disconnected",
            },
          }
        : null,
    }));

    await useGenerationStore.getState().refreshRuntimeStatus();

    const state = useGenerationStore.getState();
    expect(state.connectionStatus).toBe("connected");
    expect(state.editorReconnectSignal).toBe(0);
    expect(state.editorNeedsReconnect).toBe(false);
  });

  it("requests an editor reconnect when runtime recovers and the editor was marked unhealthy", async () => {
    useGenerationStore.setState((state) => ({
      connectionStatus: "disconnected",
      editorNeedsReconnect: true,
      editorReconnectSignal: 0,
      runtimeStatus: state.runtimeStatus
        ? {
            ...state.runtimeStatus,
            comfyui: {
              ...state.runtimeStatus.comfyui,
              status: "disconnected",
            },
          }
        : null,
    }));

    await useGenerationStore.getState().refreshRuntimeStatus();

    const state = useGenerationStore.getState();
    expect(state.connectionStatus).toBe("connected");
    expect(state.editorReconnectSignal).toBe(1);
    expect(state.editorNeedsReconnect).toBe(false);
  });

  it("adopts the workflow mask crop mode default when rules load", async () => {
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({});
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      has_sidecar: true,
      rules: makeWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            controls: [{ key: "crop_mode", default: "full" }],
            targets: [],
          },
        ],
      }),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflow("wf.json");

    expect(useGenerationStore.getState().maskCropMode).toBe("full");
  });

  it("keeps rules mode disabled when a workflow has no sidecar rules file", async () => {
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({});
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      has_sidecar: false,
      rules: makeWorkflowRules({
        nodes: {
          "145": {
            present: {
              label: "Should Not Apply",
              input_type: "video",
              param: "file",
              class_type: "LoadVideo",
            },
          },
        },
      }),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflow("wf.json");

    const state = useGenerationStore.getState();
    expect(state.rulesWorkflowSourceId).toBeNull();
    expect(state.activeWorkflowRules?.nodes).toEqual({});
  });

  it("loads generated asset metadata as a loaded workflow and applies matched sidecar rules", async () => {
    const asset = {
      id: "generated-asset",
      hash: "hash",
      name: "generated.mp4",
      type: "video" as const,
      src: "generated.mp4",
      createdAt: Date.now(),
      creationMetadata: {
        source: "generated" as const,
        workflowName: "Original Workflow",
        inputs: [],
        comfyuiPrompt: {
          "145": {
            class_type: "LoadVideo",
            inputs: { file: "source.mp4" },
          },
        },
      },
    };

    useGenerationStore.setState({
      tempWorkflow: null,
      availableWorkflows: [],
      activeWorkflowRules: null,
      activeRulesWarnings: [],
      rulesWorkflowSourceId: null,
      workflowInputs: [],
      mediaInputs: {},
    });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "match.json", name: "Matched Workflow" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      nodes: [{ id: 145, type: "LoadVideo", widgets_values: ["other.mp4"] }],
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "match.json",
      has_sidecar: true,
      rules: makeWorkflowRules({
        nodes: {
          "145": {
            present: {
              label: "Matched Video",
              input_type: "video",
              param: "file",
              class_type: "LoadVideo",
            },
          },
        },
      }),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflowFromAssetMetadata(asset);

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(
      state.availableWorkflows.some(
        (workflow) =>
          workflow.id === TEMP_WORKFLOW_ID &&
          workflow.name === "loaded workflow",
      ),
    ).toBe(true);
    expect(state.rulesWorkflowSourceId).toBe("match.json");
    expect(state.workflowInputs[0]?.label).toBe("Matched Video");
    expect(state.workflowInputs[0]?.origin).toBe("rule");
  });

  it("keeps inferred presentation when the matched workflow has no sidecar", async () => {
    const asset = {
      id: "generated-asset",
      hash: "hash",
      name: "generated.mp4",
      type: "video" as const,
      src: "generated.mp4",
      createdAt: Date.now(),
      creationMetadata: {
        source: "generated" as const,
        workflowName: "Original Workflow",
        inputs: [],
        comfyuiPrompt: {
          "145": {
            class_type: "LoadVideo",
            inputs: { file: "source.mp4" },
          },
        },
      },
    };

    useGenerationStore.setState({
      tempWorkflow: null,
      availableWorkflows: [],
      activeWorkflowRules: null,
      activeRulesWarnings: [],
      rulesWorkflowSourceId: null,
      workflowInputs: [],
      mediaInputs: {},
    });

    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "match.json", name: "Matched Workflow" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      nodes: [{ id: 145, type: "LoadVideo", widgets_values: ["other.mp4"] }],
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "match.json",
      has_sidecar: false,
      rules: makeWorkflowRules({
        nodes: {
          "145": {
            present: {
              label: "Should Not Apply",
              input_type: "video",
              param: "file",
              class_type: "LoadVideo",
            },
          },
        },
      }),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflowFromAssetMetadata(asset);

    const state = useGenerationStore.getState();
    expect(state.rulesWorkflowSourceId).toBeNull();
    expect(state.workflowInputs[0]?.origin).toBe("inferred");
  });

  it("surfaces workflow load errors when workflow discovery fails", async () => {
    vi.spyOn(comfyApi, "listWorkflows").mockRejectedValue(
      new Error("ComfyUI disconnected"),
    );

    await useGenerationStore.getState().fetchWorkflows();

    const state = useGenerationStore.getState();
    expect(state.workflowLoadError).toBe("ComfyUI disconnected");
    expect(state.workflowLoadState).toBe("error");
    expect(state.isWorkflowLoading).toBe(false);
  });

  it("blocks submission while workflow is loading", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      connectionStatus: "connected",
      selectedWorkflowId: "wf.json",
      syncedWorkflow: {},
      workflowInputs: [],
      isWorkflowLoading: true,
      workflowLoadState: "loading",
      isWorkflowReady: false,
      jobs: new Map(),
    });

    const generateSpy = vi.spyOn(comfyApi, "generate");
    const jobId = await useGenerationStore.getState().submitGeneration({});
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected an error job id");
    }
    const errorJob = useGenerationStore.getState().jobs.get(jobId);

    expect(generateSpy).not.toHaveBeenCalled();
    expect(errorJob?.status).toBe("error");
    expect(errorJob?.error).toContain("Workflow is still loading");
  });

  it("captures generated asset metadata and postprocess config at submission", async () => {
    const timelineSelection = {
      start: 10,
      end: 20,
      clips: [],
      fps: 24,
    };
    const draggedAsset = {
      id: "asset-1",
      hash: "hash",
      name: "clip.mp4",
      type: "video" as const,
      src: "blob:clip",
      createdAt: Date.now() - 2_000,
    };

    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {},
      syncedGraphData: {
        nodes: [
          {
            id: 67,
            type: "WanFirstLastFrameToVideo",
            inputs: [
              { name: "start_image", link: 157 },
              { name: "end_image", link: 158 },
            ],
          },
        ],
        links: [
          [157, 62, 0, 67, 0, "IMAGE"],
          [158, 68, 0, 67, 1, "IMAGE"],
        ],
      },
      workflowInputs: [
        {
          nodeId: "node_timeline",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Timeline Input",
          currentValue: null,
          origin: "rule",
        },
        {
          nodeId: "node_dragged",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Dragged Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {
        node_timeline: {
          kind: "timelineSelection",
          mediaType: "video",
          timelineSelection,
          thumbnailFile: new File(["thumb"], "thumb.png", {
            type: "image/png",
          }),
          thumbnailUrl: "blob:thumb",
          isExtracting: false,
          extractionRequestId: 0,
          preparedVideoFile: null,
          preparedMaskFile: null,
          extractionError: null,
        },
        node_dragged: {
          kind: "asset",
          asset: draggedAsset,
        },
      },
      activeWorkflowRules: makeWorkflowRules({
        pipeline: [
          {
            id: "output_assembly",
            kind: "output_assembly",
            config: {
              mode: "stitch_frames_with_audio",
              panel_preview: "replace_outputs",
              on_failure: "show_error",
            },
          },
        ],
      }),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-meta",
      number: 1,
      node_errors: {},
      comfyui_workflow: {
        nodes: [{ id: 999, type: "ProjectedWorkflow" }],
      },
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected a submitted job id");
    }
    const submittedJob = useGenerationStore.getState().jobs.get(jobId);

    expect(submittedJob?.generationMetadata).toEqual({
      source: "generated",
      workflowName: "Workflow Display Name",
      workflowSourceId: "video_wan_vace_14B_v2v.json",
      inputs: [
        {
          nodeId: "node_timeline",
          kind: "timelineSelection",
          timelineSelection,
        },
        {
          nodeId: "node_dragged",
          kind: "draggedAsset",
          parentAssetId: "asset-1",
        },
      ],
      comfyuiWorkflow: {
        nodes: [
          {
            id: 67,
            type: "WanFirstLastFrameToVideo",
            inputs: [
              { name: "start_image", link: 157 },
              { name: "end_image", link: 158 },
            ],
          },
        ],
        links: [
          [157, 62, 0, 67, 0, "IMAGE"],
          [158, 68, 0, 67, 1, "IMAGE"],
        ],
      },
      replayState: {
        version: 2,
        workflowSourceId: "video_wan_vace_14B_v2v.json",
        workflowInputs: [
          {
            nodeId: "node_timeline",
            classType: "LoadVideo",
            inputType: "video",
            param: "file",
            label: "Timeline Input",
            origin: "rule",
          },
          {
            nodeId: "node_dragged",
            classType: "LoadVideo",
            inputType: "video",
            param: "file",
            label: "Dragged Input",
            origin: "rule",
          },
        ],
        exactAspectRatio: false,
        maskCropMode: "crop",
        maskCropDilation: 0.1,
      },
      targetResolution: 1080,
    });
    expect(submittedJob?.postprocessConfig).toEqual({
      mode: "stitch_frames_with_audio",
      panel_preview: "replace_outputs",
      on_failure: "show_error",
    });
  });

  it("stores aspect ratio processing metadata from generation response", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {},
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            targets: [],
          },
        ],
      }),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-ar",
      number: 1,
      node_errors: {},
      pipeline_outputs: {
        aspect_ratio: {
          aspect_ratio_processing: {
            enabled: true,
            requested: {
              aspect_ratio: "16:9",
              resolution: 1080,
              width: 1080,
              height: 608,
            },
            strided: {
              width: 1088,
              height: 608,
              aspect_ratio: 1.7894736842,
              distortion: 1.00625,
              error: 0.00625,
              stride: 32,
              search_steps: 2,
            },
            applied_nodes: [
              { node_id: "49", width_param: "width", height_param: "height" },
            ],
            postprocess: {
              enabled: true,
              mode: "stretch_exact",
              apply_to: "all_visual_outputs",
              target_width: 1080,
              target_height: 608,
            },
          },
        },
      },
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected a submitted job id");
    }
    const submittedJob = useGenerationStore.getState().jobs.get(jobId);
    expect(submittedJob?.aspectRatioProcessing).toMatchObject({
      enabled: true,
      requested: { aspect_ratio: "16:9", resolution: 1080 },
      postprocess: {
        mode: "stretch_exact",
        apply_to: "all_visual_outputs",
        target_width: 1080,
        target_height: 608,
      },
    });
  });

  it("stores mask crop metadata from nested pipeline outputs on the submitted job", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {},
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [],
          },
        ],
      }),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-mask-metadata",
      number: 1,
      node_errors: {},
      pipeline_outputs: {
        mask_processing: {
          mask_crop_metadata: {
            mode: "cropped",
            crop_position: [100, 50],
            crop_size: [200, 100],
            container_size: [1000, 500],
            scale: 0.2,
          },
        },
      },
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    expect(jobId).toBe("prompt-mask-metadata");

    const submittedJob = useGenerationStore.getState().jobs.get("prompt-mask-metadata");
    const generationMetadata = submittedJob?.generationMetadata;
    expect(generationMetadata).toBeDefined();
    expect(generationMetadata?.maskCropMetadata).toEqual({
      mode: "cropped",
      crop_position: [100, 50],
      crop_size: [200, 100],
      container_size: [1000, 500],
      scale: 0.2,
    });
  });

  it("falls back to the prepared frontend mask when the backend does not echo one", async () => {
    const preparedVideoFile = new File(["video"], "prepared.mp4", {
      type: "video/mp4",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.mp4", {
      type: "video/mp4",
    });

    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {},
      workflowInputs: [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules(),
      derivedMaskMappings: [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-mask-fallback",
      number: 1,
      node_errors: {},
    });

    const jobId = await useGenerationStore.getState().submitGeneration({
      video_input: {
        type: "video_selection",
        selection: {
          start: 0,
          end: 24,
          clips: [],
          fps: 24,
        },
        preparedVideoFile,
        preparedMaskFile,
      },
    });

    expect(jobId).toBe("prompt-mask-fallback");
    expect(
      useGenerationStore.getState().jobs.get("prompt-mask-fallback")
        ?.preparedMaskFile,
    ).toBe(preparedMaskFile);
  });

  it("collects websocket output frames only for SaveImageWebsocket workflows", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {
        "1": { class_type: "LoadVideo", inputs: {} },
        "2": { class_type: "SaveImageWebsocket", inputs: {} },
      },
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules(),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
      jobPreviewFrames: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-ws",
      number: 1,
      node_errors: {},
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    const state = useGenerationStore.getState();
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected a submitted job id");
    }
    const submittedJob = state.jobs.get(jobId);

    expect(submittedJob?.usesSaveImageWebsocketOutputs).toBe(true);
    expect(state.jobPreviewFrames.has(jobId)).toBe(true);
  });

  it("does not collect websocket output frames for non-websocket workflows", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {
        "1": { class_type: "LoadVideo", inputs: {} },
        "2": { class_type: "SaveImage", inputs: {} },
      },
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules(),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
      jobPreviewFrames: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-non-ws",
      number: 1,
      node_errors: {},
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    const state = useGenerationStore.getState();
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected a submitted job id");
    }
    const submittedJob = state.jobs.get(jobId);

    expect(submittedJob?.usesSaveImageWebsocketOutputs).toBe(false);
    expect(state.jobPreviewFrames.has(jobId)).toBe(false);
  });

  it("collects websocket output frames for BMP websocket workflows", async () => {
    useGenerationStore.setState({
      wsClient: {
        currentClientId: "client-id",
        isConnected: true,
      } as unknown as ComfyUIWebSocket,
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
      syncedWorkflow: {
        "1": { class_type: "LoadVideo", inputs: {} },
        "2": { class_type: "VLOSaveImageWebsocketBMP", inputs: {} },
      },
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: makeWorkflowRules(),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
      jobPreviewFrames: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-bmp-ws",
      number: 1,
      node_errors: {},
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});
    const state = useGenerationStore.getState();
    expect(jobId).not.toBeNull();
    if (!jobId) {
      throw new Error("Expected a submitted job id");
    }
    const submittedJob = state.jobs.get(jobId);

    expect(submittedJob?.usesSaveImageWebsocketOutputs).toBe(true);
    expect(state.jobPreviewFrames.has(jobId)).toBe(true);
  });

  it("marks active job as error and clears activeJobId when cancel fails", async () => {
    const runningJob = makeRunningJob("prompt-1");
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      connectionStatus: "connected",
    });
    vi.spyOn(comfyApi, "interrupt").mockRejectedValue(
      new Error("Interrupt failed: 502"),
    );

    await useGenerationStore.getState().cancelGeneration();

    const state = useGenerationStore.getState();
    const job = state.jobs.get(runningJob.id);
    expect(job?.status).toBe("error");
    expect(job?.error).toContain("Cancel failed");
    expect(state.activeJobId).toBeNull();
    expect(state.connectionStatus).toBe("error");
  });

  it("marks active job as cancelled when interrupt succeeds", async () => {
    const runningJob = makeRunningJob("prompt-2");
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      connectionStatus: "connected",
    });
    vi.spyOn(comfyApi, "interrupt").mockResolvedValue(undefined);

    await useGenerationStore.getState().cancelGeneration();

    const state = useGenerationStore.getState();
    const job = state.jobs.get(runningJob.id);
    expect(job?.status).toBe("error");
    expect(job?.error).toBe("Generation cancelled by user");
    expect(state.activeJobId).toBeNull();
  });

  it("revokes preview animation URLs when cancelling a running job", async () => {
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const runningJob = makeRunningJob("prompt-animated");
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      previewAnimation: {
        frameUrls: ["blob:animated-0", null, "blob:animated-2"],
        frameRate: 8,
        totalFrames: 3,
      },
    });
    vi.spyOn(comfyApi, "interrupt").mockResolvedValue(undefined);

    await useGenerationStore.getState().cancelGeneration();

    const state = useGenerationStore.getState();
    expect(state.previewAnimation).toBeNull();
    expect(revokeSpy).toHaveBeenCalledWith("blob:animated-0");
    expect(revokeSpy).toHaveBeenCalledWith("blob:animated-2");
  });

  it("revokes postprocessed preview URL when clearing a job", () => {
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const completedJob = makeRunningJob("prompt-with-preview");
    completedJob.postprocessedPreview = {
      previewUrl: "blob:postprocessed-preview",
      mediaKind: "video",
      filename: "preview.mp4",
    };
    useGenerationStore.setState({
      jobs: new Map([[completedJob.id, completedJob]]),
    });

    useGenerationStore.getState().clearJob(completedJob.id);

    expect(revokeSpy).toHaveBeenCalledWith("blob:postprocessed-preview");
    expect(
      useGenerationStore.getState().jobs.has(completedJob.id),
    ).toBe(false);
  });

  it("reassigns a media input into an empty target slot", () => {
    const startFrame = {
      kind: "frame" as const,
      file: new File(["start"], "start.png", { type: "image/png" }),
      previewUrl: "blob:start",
      timelineSelection: null,
    };

    useGenerationStore.setState({
      workflowInputs: [
        {
          id: "62:image",
          nodeId: "62",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Start frame",
          currentValue: null,
          origin: "rule",
        },
        {
          id: "68:image",
          nodeId: "68",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "End frame",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {
        "62:image": startFrame,
      },
    });

    useGenerationStore.getState().reassignMediaInput("62:image", "68:image");

    expect(useGenerationStore.getState().mediaInputs).toEqual({
      "68:image": startFrame,
    });
  });

  it("swaps populated media inputs when reassigning into a filled target slot", () => {
    const startFrame = {
      kind: "frame" as const,
      file: new File(["start"], "start.png", { type: "image/png" }),
      previewUrl: "blob:start",
      timelineSelection: null,
    };
    const endFrame = {
      kind: "frame" as const,
      file: new File(["end"], "end.png", { type: "image/png" }),
      previewUrl: "blob:end",
      timelineSelection: null,
    };

    useGenerationStore.setState({
      workflowInputs: [
        {
          id: "62:image",
          nodeId: "62",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Start frame",
          currentValue: null,
          origin: "rule",
        },
        {
          id: "68:image",
          nodeId: "68",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "End frame",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {
        "62:image": startFrame,
        "68:image": endFrame,
      },
    });

    useGenerationStore.getState().reassignMediaInput("62:image", "68:image");

    expect(useGenerationStore.getState().mediaInputs).toEqual({
      "62:image": endFrame,
      "68:image": startFrame,
    });
  });
});
