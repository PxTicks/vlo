import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import type { WorkflowInput } from "../types";
import * as comfyApi from "../services/comfyuiApi";
import type { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import type { GenerationJob } from "../types";
import type { WorkflowRules } from "../services/workflowRules";
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
  return {
    version: 1,
    nodes: {},
    output_injections: {},
    slots: {},
    mask_cropping: { mode: "crop" },
    postprocessing: {
      mode: "auto",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    },
    ...overrides,
  };
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

    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
        fps: 30,
        layoutMode: "compact",
      },
    });

    useGenerationStore.setState({
      editorRef: null,
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
        aspect_ratio_processing: {
          enabled: true,
          stride: 16,
          search_steps: 2,
          resolutions: [480, 720],
          target_nodes: [],
          postprocess: {
            enabled: true,
            mode: "stretch_exact",
            apply_to: "all_visual_outputs",
          },
        },
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

  it("adopts the workflow mask crop mode default when rules load", async () => {
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({});
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      rules: makeWorkflowRules({
        mask_cropping: { mode: "full" },
      }),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflow("wf.json");

    expect(useGenerationStore.getState().maskCropMode).toBe("full");
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
          timelineSelection,
          thumbnailFile: new File(["thumb"], "thumb.png", {
            type: "image/png",
          }),
          thumbnailUrl: "blob:thumb",
          isExtracting: false,
          extractionRequestId: 0,
          preparedVideoFile: null,
          preparedMaskFile: null,
          preparedDerivedMaskVideoTreatment: null,
          extractionError: null,
        },
        node_dragged: {
          kind: "asset",
          asset: draggedAsset,
        },
      },
      activeWorkflowRules: makeWorkflowRules({
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "replace_outputs",
          on_failure: "show_error",
        },
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
      activeWorkflowRules: makeWorkflowRules(),
      isWorkflowLoading: false,
      workflowLoadState: "ready",
      isWorkflowReady: true,
      jobs: new Map(),
    });

    vi.spyOn(comfyApi, "generate").mockResolvedValue({
      prompt_id: "prompt-ar",
      number: 1,
      node_errors: {},
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

  it("falls back to the prepared frontend mask when the backend does not echo one", async () => {
    const preparedVideoFile = new File(["video"], "prepared.webm", {
      type: "video/webm",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.webm", {
      type: "video/webm",
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

  it("revokes postprocessed preview URL when clearing a job", () => {
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const completedJob = makeRunningJob("prompt-with-preview");
    completedJob.postprocessedPreview = {
      previewUrl: "blob:postprocessed-preview",
      mediaKind: "video",
      filename: "preview.webm",
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
});
