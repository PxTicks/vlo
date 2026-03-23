import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_PIPELINE_STATUS } from "../constants";
import {
  applyPreviewUpdate,
  completeGenerationJob,
  markActiveJobError,
} from "../jobMutations";
import type { GenerationStore } from "../types";

function makeStoreState(
  overrides: Partial<GenerationStore> = {},
): GenerationStore {
  return {
    connectionStatus: "connected",
    runtimeStatus: null,
    runtimeStatusError: null,
    comfyuiDirectUrl: null,
    wsClient: null,
    objectInfoSynced: false,
    inputNodeMap: null,
    editorNeedsReconnect: false,
    editorReconnectSignal: 0,
    setEditorNeedsReconnect: () => {},
    requestEditorReconnect: () => {},
    connect: () => {},
    disconnect: () => {},
    refreshRuntimeStatus: async () => null,
    updateComfyUrl: async () => {},
    syncObjectInfo: async () => {},
    pipelineStatus: IDLE_PIPELINE_STATUS,
    pipelineRunToken: 0,
    preprocessAbortController: null,
    syncedWorkflow: null,
    syncedGraphData: null,
    workflowInputs: [],
    availableWorkflows: [],
    tempWorkflow: null,
    selectedWorkflowId: null,
    isWorkflowLoading: false,
    workflowLoadState: "idle",
    workflowLoadError: null,
    isWorkflowReady: false,
    workflowWarning: null,
    hasInferredInputs: false,
    workflowRuleWarnings: [],
    activeWorkflowRules: null,
    rulesWorkflowSourceId: null,
    activeRulesWarnings: [],
    derivedMaskMappings: [],
    maskCropMode: "crop",
    targetResolution: 1080,
    setTargetResolution: () => {},
    setMaskCropMode: () => {},
    maskCropDilation: 0.1,
    setMaskCropDilation: () => {},
    lastAppliedWidgetValues: {},
    mediaInputs: {},
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    latestPreviewUrl: null,
    previewAnimation: null,
    editorRef: null,
    registerEditor: () => {},
    unregisterEditor: () => {},
    setWorkflowLoading: () => {},
    setWorkflowLoadState: () => {},
    clearWorkflowWarning: () => {},
    clearWorkflowLoadError: () => {},
    setMediaInputAsset: () => {},
    setMediaInputFrame: () => {},
    setMediaInputTimelineSelection: () => {},
    clearMediaInput: () => {},
    loadWorkflow: async () => {},
    syncWorkflow: () => {},
    registerWorkflowFromEditor: async () => {},
    fetchWorkflows: async () => {},
    loadWorkflowFromAssetMetadata: async () => {},
    importOutput: async () => {},
    clearJob: () => {},
    submitGeneration: async () => null,
    cancelGeneration: async () => {},
    ...overrides,
  };
}

describe("jobMutations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the active job as error and clears preview state", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const state = makeStoreState({
      activeJobId: "job-1",
      previewAnimation: {
        frameUrls: ["blob:1"],
        frameRate: 12,
        totalFrames: 1,
      },
      jobPreviewFrames: new Map([["job-1", [new File(["x"], "frame.png")]]]),
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 20,
            currentNode: "node-1",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
          },
        ],
      ]),
    });

    const patch = markActiveJobError(state, "boom", {
      completedAt: 10,
      nextConnectionStatus: "error",
    });

    expect(patch.activeJobId).toBeNull();
    expect(patch.previewAnimation).toBeNull();
    expect(patch.connectionStatus).toBe("error");
    expect(patch.jobs?.get("job-1")).toMatchObject({
      status: "error",
      error: "boom",
      completedAt: 10,
    });
    expect(revokeSpy).toHaveBeenCalledWith("blob:1");
  });

  it("marks a job completed and clears it as the active job", () => {
    const state = makeStoreState({
      activeJobId: "job-1",
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 80,
            currentNode: "node-2",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
          },
        ],
      ]),
    });

    const result = completeGenerationJob(state, "job-1");

    expect(result.completedJob).not.toBeNull();
    expect(result.patch.activeJobId).toBeNull();
    expect(result.patch.jobs?.get("job-1")).toMatchObject({
      status: "completed",
      progress: 100,
      currentNode: null,
    });
  });

  it("collects websocket preview frames for SaveImageWebsocket outputs", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:latest");

    const state = makeStoreState({
      activeJobId: "job-1",
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 50,
            currentNode: "save-node",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
            postprocessConfig: {
              mode: "auto",
              panel_preview: "raw_outputs",
              on_failure: "fallback_raw",
            },
            usesSaveImageWebsocketOutputs: true,
            saveImageWebsocketNodeIds: new Set(["save-node"]),
          },
        ],
      ]),
    });

    const patch = applyPreviewUpdate(state, {
      blob: new Blob(["frame"], { type: "image/png" }),
    });

    expect(patch.latestPreviewUrl).toBe("blob:latest");
    expect(patch.jobPreviewFrames?.get("job-1")).toHaveLength(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
