import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob } from "../types";
import type { WorkflowRules } from "../services/workflowRules";

const {
  mockFrontendPostprocess,
  mockFrontendPreprocess,
  mockGenerate,
  mockGetConfig,
  mockGetRuntimeStatus,
  mockGetHistoryOutputsWithRetry,
  mockInterrupt,
  mockListWorkflows,
  mockWsInstances,
} = vi.hoisted(() => ({
  mockFrontendPostprocess: vi.fn(),
  mockFrontendPreprocess: vi.fn(),
  mockGenerate: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetRuntimeStatus: vi.fn(),
  mockGetHistoryOutputsWithRetry: vi.fn(),
  mockInterrupt: vi.fn(),
  mockListWorkflows: vi.fn(),
  mockWsInstances: [] as unknown[],
}));

interface MockWsClient {
  currentClientId: string;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  emitEvent: (event: unknown) => void;
  emitPreview: (blob: Blob) => void;
  emitConnectionChange: (state: "connected" | "disconnected") => void;
}

vi.mock("../services/ComfyUIWebSocket", () => ({
  ComfyUIWebSocket: class {
    currentClientId = "client-id";
    isConnected = false;
    private readonly eventHandlers = new Set<(event: unknown) => void>();
    private readonly previewHandlers = new Set<(blob: Blob) => void>();
    private readonly connectionChangeHandlers = new Set<
      (state: "connected" | "disconnected") => void
    >();

    constructor(...args: [string]) {
      void args;
      mockWsInstances.push(this);
    }

    connect(): void {
      this.isConnected = true;
    }

    disconnect(): void {
      this.isConnected = false;
      for (const handler of this.connectionChangeHandlers) {
        handler("disconnected");
      }
    }

    onEvent(handler: (event: unknown) => void): () => void {
      this.eventHandlers.add(handler);
      return () => {
        this.eventHandlers.delete(handler);
      };
    }

    onPreview(handler: (blob: Blob) => void): () => void {
      this.previewHandlers.add(handler);
      return () => {
        this.previewHandlers.delete(handler);
      };
    }

    onConnectionChange(
      handler: (state: "connected" | "disconnected") => void,
    ): () => void {
      this.connectionChangeHandlers.add(handler);
      return () => {
        this.connectionChangeHandlers.delete(handler);
      };
    }

    emitEvent(event: unknown): void {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    }

    emitPreview(blob: Blob): void {
      for (const handler of this.previewHandlers) {
        handler(blob);
      }
    }

    emitConnectionChange(state: "connected" | "disconnected"): void {
      for (const handler of this.connectionChangeHandlers) {
        handler(state);
      }
    }
  },
}));

vi.mock("../services/comfyuiApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/comfyuiApi")>();
  return {
    ...actual,
    generate: mockGenerate,
    getConfig: mockGetConfig,
    interrupt: mockInterrupt,
    listWorkflows: mockListWorkflows,
  };
});

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeStatus: mockGetRuntimeStatus,
}));

vi.mock("../store/history", () => ({
  getHistoryOutputsWithRetry: mockGetHistoryOutputsWithRetry,
}));

vi.mock("../utils/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pipeline")>();
  return {
    ...actual,
    frontendPreprocess: mockFrontendPreprocess,
    frontendPostprocess: mockFrontendPostprocess,
  };
});

import { useGenerationStore } from "../useGenerationStore";

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

function makeReadyStoreState(): void {
  useGenerationStore.setState({
    wsClient: {
      currentClientId: "client-id",
      isConnected: true,
      connect: () => {},
      disconnect: () => {},
    } as never,
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
    pipelineStatus: {
      phase: "idle",
      message: null,
      interruptible: false,
    },
    pipelineRunToken: 0,
    preprocessAbortController: null,
    selectedWorkflowId: "wf.json",
    availableWorkflows: [{ id: "wf.json", name: "Workflow Display Name" }],
    syncedWorkflow: {},
    workflowInputs: [],
    mediaInputs: {},
    activeWorkflowRules: makeWorkflowRules(),
    activeRulesWarnings: [],
    rulesWorkflowSourceId: "wf.json",
    derivedMaskMappings: [],
    targetResolution: 1080,
    maskCropMode: "crop",
    isWorkflowLoading: false,
    workflowLoadState: "ready",
    isWorkflowReady: true,
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    workflowRuleWarnings: [],
    lastAppliedWidgetValues: {},
  });
}

function makeQueuedJob(id: string): GenerationJob {
  return {
    id,
    status: "queued",
    progress: 0,
    currentNode: null,
    outputs: [],
    error: null,
    submittedAt: Date.now() - 1_000,
    completedAt: null,
    postprocessConfig: {
      mode: "auto",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    },
    generationMetadata: {
      source: "generated",
      workflowName: "Workflow Display Name",
      inputs: [],
    },
    postprocessedPreview: null,
    postprocessError: null,
    usesSaveImageWebsocketOutputs: false,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getLatestClient(): MockWsClient {
  const latest = mockWsInstances[mockWsInstances.length - 1];
  if (!latest) {
    throw new Error("Expected a websocket client instance");
  }
  return latest as MockWsClient;
}

describe("useGenerationStore pipeline phases", () => {
  beforeEach(() => {
    mockWsInstances.length = 0;
    mockFrontendPreprocess.mockReset();
    mockFrontendPostprocess.mockReset();
    mockGenerate.mockReset();
    mockGetConfig.mockReset();
    mockGetRuntimeStatus.mockReset();
    mockGetHistoryOutputsWithRetry.mockReset();
    mockInterrupt.mockReset();
    mockListWorkflows.mockReset();

    mockFrontendPreprocess.mockImplementation(
      async (
        syncedWorkflow: Record<string, unknown> | null,
        workflowId: string | null,
        _workflowInputs: unknown,
        _slotValues: unknown,
        clientId: string,
      ) => ({
        workflow: syncedWorkflow,
        workflowId,
        targetAspectRatio: "16:9",
        targetResolution: 1080,
        textInputs: {},
        imageInputs: {},
        videoInputs: {},
        manualSlotTextInputs: {},
        manualSlotImageInputs: {},
        manualSlotVideoInputs: {},
        manualSlotAudioInputs: {},
        clientId,
      }),
    );
    mockFrontendPostprocess.mockResolvedValue({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    mockGenerate.mockResolvedValue({
      prompt_id: "prompt-1",
      number: 1,
      node_errors: {},
    });
    mockGetConfig.mockResolvedValue({
      comfyui_url: "http://localhost:8188",
    });
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
    mockGetHistoryOutputsWithRetry.mockResolvedValue([
      {
        filename: "output.png",
        subfolder: "",
        type: "output",
        viewUrl: "/output.png",
      },
    ]);
    mockInterrupt.mockResolvedValue(undefined);
    mockListWorkflows.mockResolvedValue([]);

    useGenerationStore.setState({
      wsClient: null,
      connectionStatus: "disconnected",
      pipelineStatus: {
        phase: "idle",
        message: null,
        interruptible: false,
      },
      pipelineRunToken: 0,
      preprocessAbortController: null,
      selectedWorkflowId: null,
      availableWorkflows: [],
      syncedWorkflow: null,
      workflowInputs: [],
      mediaInputs: {},
      activeWorkflowRules: null,
      activeRulesWarnings: [],
      rulesWorkflowSourceId: null,
      derivedMaskMappings: [],
      targetResolution: 1080,
      maskCropMode: "crop",
      isWorkflowLoading: false,
      workflowLoadState: "idle",
      isWorkflowReady: false,
      jobs: new Map(),
      jobPreviewFrames: new Map(),
      activeJobId: null,
      workflowRuleWarnings: [],
      lastAppliedWidgetValues: {},
      latestPreviewUrl: null,
    });
  });

  afterEach(() => {
    useGenerationStore.getState().disconnect();
    vi.restoreAllMocks();
  });

  it("enters preprocessing immediately before preprocess resolves", async () => {
    makeReadyStoreState();
    const preprocessDeferred = createDeferred<{
      workflow: Record<string, unknown> | null;
      workflowId: string | null;
      targetAspectRatio: string;
      targetResolution: number;
      textInputs: Record<string, string>;
      imageInputs: Record<string, File>;
      videoInputs: Record<string, File>;
      manualSlotTextInputs: Record<string, string>;
      manualSlotImageInputs: Record<string, File>;
      manualSlotVideoInputs: Record<string, File>;
      manualSlotAudioInputs: Record<string, File>;
      clientId: string;
    }>();
    mockFrontendPreprocess.mockReturnValue(preprocessDeferred.promise);

    const submitPromise = useGenerationStore.getState().submitGeneration({});
    const stateWhilePending = useGenerationStore.getState();

    expect(stateWhilePending.pipelineStatus).toEqual({
      phase: "preprocessing",
      message: "Preparing asset",
      interruptible: true,
    });
    expect(stateWhilePending.preprocessAbortController).not.toBeNull();

    preprocessDeferred.resolve({
      workflow: {},
      workflowId: "wf.json",
      targetAspectRatio: "16:9",
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      videoInputs: {},
      manualSlotTextInputs: {},
      manualSlotImageInputs: {},
      manualSlotVideoInputs: {},
      manualSlotAudioInputs: {},
      clientId: "client-id",
    });

    const jobId = await submitPromise;
    expect(jobId).toBe("prompt-1");
    expect(useGenerationStore.getState().pipelineStatus.phase).toBe("idle");
  });

  it("passes the runtime mask crop mode into frontend preprocess", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      derivedMaskMappings: [
        {
          sourceNodeId: "1",
          maskNodeId: "2",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      maskCropMode: "full",
      maskCropDilation: 0.2,
    });

    await useGenerationStore.getState().submitGeneration({});

    expect(mockFrontendPreprocess).toHaveBeenCalledWith(
      {},
      "wf.json",
      [],
      {},
      "client-id",
      [
        {
          sourceNodeId: "1",
          maskNodeId: "2",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      0.2,
      expect.objectContaining({
        maskCropMode: "full",
        targetResolution: 1080,
        signal: expect.any(AbortSignal),
      }),
      null,
    );
  });

  it("cancels preprocess locally, ignores stale completion, and leaves no error job", async () => {
    makeReadyStoreState();
    const preprocessDeferred = createDeferred<{
      workflow: Record<string, unknown> | null;
      workflowId: string | null;
      targetAspectRatio: string;
      targetResolution: number;
      textInputs: Record<string, string>;
      imageInputs: Record<string, File>;
      videoInputs: Record<string, File>;
      manualSlotTextInputs: Record<string, string>;
      manualSlotImageInputs: Record<string, File>;
      manualSlotVideoInputs: Record<string, File>;
      manualSlotAudioInputs: Record<string, File>;
      clientId: string;
    }>();
    mockFrontendPreprocess.mockReturnValue(preprocessDeferred.promise);

    const submitPromise = useGenerationStore.getState().submitGeneration({});
    await useGenerationStore.getState().cancelGeneration();

    expect(mockInterrupt).not.toHaveBeenCalled();
    expect(useGenerationStore.getState().pipelineStatus.phase).toBe("idle");
    expect(useGenerationStore.getState().jobs.size).toBe(0);

    preprocessDeferred.resolve({
      workflow: {},
      workflowId: "wf.json",
      targetAspectRatio: "16:9",
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      videoInputs: {},
      manualSlotTextInputs: {},
      manualSlotImageInputs: {},
      manualSlotVideoInputs: {},
      manualSlotAudioInputs: {},
      clientId: "client-id",
    });

    const jobId = await submitPromise;
    expect(jobId).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(useGenerationStore.getState().pipelineStatus.phase).toBe("idle");
    expect(useGenerationStore.getState().jobs.size).toBe(0);
  });

  it("enters postprocessing after completion and clears once postprocess finishes", async () => {
    const postprocessDeferred = createDeferred<{
      postprocessedPreview: null;
      postprocessError: null;
      importedAssetIds: string[];
    }>();
    mockFrontendPostprocess.mockReturnValue(postprocessDeferred.promise);

    useGenerationStore.setState({
      jobs: new Map([["prompt-post", makeQueuedJob("prompt-post")]]),
      activeJobId: "prompt-post",
      pipelineRunToken: 1,
    });

    useGenerationStore.getState().connect();
    const client = getLatestClient();
    client.emitEvent({
      type: "executing",
      data: {
        node: null,
        prompt_id: "prompt-post",
      },
    });
    await flushMicrotasks();

    expect(useGenerationStore.getState().pipelineStatus).toEqual({
      phase: "postprocessing",
      message: "Rendering generation",
      interruptible: false,
    });

    postprocessDeferred.resolve({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    await flushMicrotasks();

    const state = useGenerationStore.getState();
    expect(state.pipelineStatus.phase).toBe("idle");
    expect(state.jobs.get("prompt-post")?.importedAssetIds).toEqual([
      "asset-1",
    ]);
  });

  it("refreshes runtime status when the websocket proxy emits an error", async () => {
    useGenerationStore.getState().connect();
    const client = getLatestClient();

    expect(mockGetRuntimeStatus).toHaveBeenCalledTimes(1);

    client.emitEvent({
      type: "error",
      data: {
        message: "Proxy disconnected",
      },
    });
    await flushMicrotasks();

    expect(mockGetRuntimeStatus).toHaveBeenCalledTimes(2);
  });

  it("blocks new submissions while postprocessing is active", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      pipelineStatus: {
        phase: "postprocessing",
        message: "Rendering generation",
        interruptible: false,
      },
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});

    expect(jobId).toBeNull();
    expect(mockFrontendPreprocess).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
