import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob, WorkflowInput } from "../types";
import {
  createDefaultWorkflowRules,
  type WorkflowRules,
} from "../services/workflowRules";
import { useProjectStore } from "../../project";

const {
  mockBridgeReadActive,
  mockDeliveryWsInstances,
  mockDeleteQueueItems,
  mockFrontendPostprocess,
  mockFrontendPreprocess,
  mockGenerate,
  mockGetConfig,
  mockGetRuntimeStatus,
  mockInterrupt,
  mockListWorkflows,
  mockPreResolvePrompt,
  mockWsInstances,
} = vi.hoisted(() => ({
  mockBridgeReadActive: vi.fn(),
  mockDeleteQueueItems: vi.fn(),
  mockDeliveryWsInstances: [] as unknown[],
  mockFrontendPostprocess: vi.fn(),
  mockFrontendPreprocess: vi.fn(),
  mockGenerate: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetRuntimeStatus: vi.fn(),
  mockInterrupt: vi.fn(),
  mockListWorkflows: vi.fn(),
  mockPreResolvePrompt: vi.fn(),
  mockWsInstances: [] as unknown[],
}));

interface MockWsClient {
  currentClientId: string;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  emitEvent: (event: unknown) => void;
  emitPreview: (preview: {
    blob: Blob;
    frameIndex?: number;
    frameRate?: number;
    totalFrames?: number;
  }) => void;
  emitConnectionChange: (state: "connected" | "disconnected") => void;
}

vi.mock("../services/ComfyUIWebSocket", () => ({
  ComfyUIWebSocket: class {
    currentClientId = "client-id";
    isConnected = false;
    private readonly eventHandlers = new Set<(event: unknown) => void>();
    private readonly previewHandlers = new Set<
      (preview: {
        blob: Blob;
        frameIndex?: number;
        frameRate?: number;
        totalFrames?: number;
      }) => void
    >();
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

    onPreview(
      handler: (preview: {
        blob: Blob;
        frameIndex?: number;
        frameRate?: number;
        totalFrames?: number;
      }) => void,
    ): () => void {
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

    emitPreview(preview: {
      blob: Blob;
      frameIndex?: number;
      frameRate?: number;
      totalFrames?: number;
    }): void {
      for (const handler of this.previewHandlers) {
        handler(preview);
      }
    }

    emitConnectionChange(state: "connected" | "disconnected"): void {
      for (const handler of this.connectionChangeHandlers) {
        handler(state);
      }
    }
  },
}));

vi.mock("../services/GenerationDeliveryWebSocket", () => ({
  GenerationDeliveryWebSocket: class {
    readonly boundProjectId: string;
    isConnected = false;
    private readonly messageHandlers = new Set<(message: unknown) => void>();
    private readonly previewHandlers = new Set<(preview: unknown) => void>();
    private readonly connectionChangeHandlers = new Set<
      (state: "connected" | "disconnected") => void
    >();

    constructor(_baseUrl: string, projectId: string) {
      this.boundProjectId = projectId;
      mockDeliveryWsInstances.push(this);
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

    acknowledgeDelivery(): void {}

    rejectDelivery(): void {}

    onMessage(handler: (message: unknown) => void): () => void {
      this.messageHandlers.add(handler);
      return () => {
        this.messageHandlers.delete(handler);
      };
    }

    onPreview(handler: (preview: unknown) => void): () => void {
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

    emitMessage(message: unknown): void {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    }

    emitPreview(preview: {
      blob: Blob;
      frameIndex?: number;
      frameRate?: number;
      totalFrames?: number;
    }): void {
      for (const handler of this.previewHandlers) {
        handler(preview);
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
    deleteQueueItems: mockDeleteQueueItems,
    listWorkflows: mockListWorkflows,
  };
});

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeStatus: mockGetRuntimeStatus,
}));

vi.mock("../utils/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pipeline")>();
  return {
    ...actual,
    frontendPreprocess: mockFrontendPreprocess,
    frontendPostprocess: mockFrontendPostprocess,
  };
});

vi.mock("../services/iframeBridgeClient", () => ({
  iframeBridge: {
    isReady: false,
    bindIframe: () => {},
    notifyIframeReloaded: () => {},
    onReady: () => () => {},
    onGraphChanged: () => () => {},
    onHealthChanged: () => () => {},
    waitForReady: async () => false,
    health: async () => null,
    readActive: mockBridgeReadActive,
    injectWorkflow: async () => null,
    resolvePrompt: mockPreResolvePrompt,
    refreshMissingModels: async () => false,
    readPendingWarnings: async () => null,
  },
}));

import { useGenerationStore } from "../useGenerationStore";

function makeWorkflowRules(
  overrides: Partial<WorkflowRules> = {},
): WorkflowRules {
  return createDefaultWorkflowRules(overrides);
}

function makeReadyStoreState(): void {
  useGenerationStore.setState({
    wsClient: {
      currentClientId: "client-id",
      isConnected: true,
      connect: () => {},
      disconnect: () => {},
    } as never,
    // Disable the graphToPrompt-based submission capture for tests that
    // don't mount a real ComfyUI iframe; tests that DO want to exercise the
    // capture path set their own iframe-shaped editorRef and re-enable it.
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
    iframeWorkflowInstanceId: "workflow-instance",
    iframeWorkflowRevision: 0,
    workflowInputs: [],
    mediaInputs: {},
    activeWorkflowRules: makeWorkflowRules(),
    activeRulesWarnings: [],
    rulesWorkflowSourceId: "wf.json",
    derivedMaskMappings: [],
    targetResolution: 1080,
    maskCropMode: "crop",
    maskCropDilation: 0.1,
    isWorkflowLoading: false,
    workflowLoadState: "ready",
    isWorkflowReady: true,
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    previewAnimation: null,
    workflowRuleWarnings: [],
    lastAppliedWidgetValues: {},
    generationQueue: [],
    postprocessingJobIds: [],
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

function makeWorkflowInput(
  overrides: Partial<WorkflowInput> & Pick<WorkflowInput, "nodeId" | "inputType" | "param">,
): WorkflowInput {
  return {
    classType:
      overrides.classType ??
      (overrides.inputType === "text"
        ? "CLIPTextEncode"
        : overrides.inputType === "image"
          ? "LoadImage"
          : overrides.inputType === "audio"
            ? "LoadAudio"
            : "LoadVideo"),
    currentValue: overrides.currentValue ?? null,
    description: overrides.description ?? null,
    inputType: overrides.inputType,
    label: overrides.label ?? overrides.nodeId,
    nodeId: overrides.nodeId,
    origin: overrides.origin ?? "rule",
    param: overrides.param,
    ...(overrides.id ? { id: overrides.id } : {}),
    ...(overrides.dispatch ? { dispatch: overrides.dispatch } : {}),
    ...(overrides.presentation
      ? { presentation: overrides.presentation }
      : {}),
  };
}

function makeTestFile(
  content: string,
  fileName: string,
  options: FilePropertyBag,
): File {
  const file = new File([content], fileName, options);
  if (typeof file.arrayBuffer !== "function") {
    const bytes = new TextEncoder().encode(content);
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        Promise.resolve(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        ),
    });
  }
  return file;
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

interface MockDeliveryClient {
  readonly boundProjectId: string;
  readonly isConnected: boolean;
  emitMessage: (message: unknown) => void;
  emitPreview: (preview: {
    blob: Blob;
    frameIndex?: number;
    frameRate?: number;
    totalFrames?: number;
  }) => void;
  emitConnectionChange: (state: "connected" | "disconnected") => void;
}

function getLatestDeliveryClient(): MockDeliveryClient {
  const latest = mockDeliveryWsInstances[mockDeliveryWsInstances.length - 1];
  if (!latest) {
    throw new Error("Expected a delivery websocket client instance");
  }
  return latest as MockDeliveryClient;
}

describe("useGenerationStore pipeline phases", () => {
  beforeEach(() => {
    mockWsInstances.length = 0;
    mockDeliveryWsInstances.length = 0;
    mockFrontendPreprocess.mockReset();
    mockFrontendPostprocess.mockReset();
    mockGenerate.mockReset();
    mockGetConfig.mockReset();
    mockGetRuntimeStatus.mockReset();
    mockInterrupt.mockReset();
    mockListWorkflows.mockReset();
    mockPreResolvePrompt.mockReset();
    mockBridgeReadActive.mockReset();
    mockBridgeReadActive.mockResolvedValue(null);

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
        exactAspectRatio: false,
        targetResolution: 1080,
        textInputs: {},
        imageInputs: {},
        audioInputs: {},
        videoInputs: {},
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
    mockInterrupt.mockResolvedValue(undefined);
    mockListWorkflows.mockResolvedValue([]);
    mockPreResolvePrompt.mockResolvedValue({
      output: {
        "999": {
          class_type: "PreResolvedWorkflow",
          inputs: {},
        },
      },
      workflow: {},
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
      wsClient: null,
      deliveryClient: null,
      connectionStatus: "disconnected",
      deliveryConnectionStatus: "disconnected",
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
      exactAspectRatio: false,
      targetResolution: 1080,
      maskCropMode: "crop",
      maskCropDilation: 0.1,
      isWorkflowLoading: false,
      workflowLoadState: "idle",
      isWorkflowReady: false,
      jobs: new Map(),
      jobPreviewFrames: new Map(),
      activeJobId: null,
      previewAnimation: null,
      workflowRuleWarnings: [],
      lastAppliedWidgetValues: {},
      latestPreviewUrl: null,
      generationQueue: [],
      postprocessingJobIds: [],
    });
  });

  afterEach(() => {
    useGenerationStore.getState().disconnect();
    useProjectStore.setState({
      project: null,
    });
    vi.restoreAllMocks();
  });

  it("enters preprocessing immediately before preprocess resolves", async () => {
    makeReadyStoreState();
    const preprocessDeferred = createDeferred<{
      workflow: Record<string, unknown> | null;
      workflowId: string | null;
      targetAspectRatio: string;
      exactAspectRatio: boolean;
      targetResolution: number;
      textInputs: Record<string, string>;
      imageInputs: Record<string, File>;
      audioInputs: Record<string, File>;
      videoInputs: Record<string, File>;
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
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
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
      expect.any(Object),
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

  it("dispatches replay-derived temp workflows with their original rules source id", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      selectedWorkflowId: "__temp__.json",
      rulesWorkflowSourceId: "wan2_2_flf2v.json",
    });

    await useGenerationStore.getState().submitGeneration({});

    expect(mockFrontendPreprocess).toHaveBeenCalledWith(
      {},
      "wan2_2_flf2v.json",
      expect.any(Object),
      [],
      {},
      "client-id",
      [],
      0.1,
      expect.objectContaining({
        maskCropMode: "crop",
        targetResolution: 1080,
        signal: expect.any(AbortSignal),
      }),
      null,
    );
  });

  it("submits the active resolved workflow rules with backend media fallbacks intact", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      activeWorkflowRules: makeWorkflowRules({
        nodes: {
          "167": {
            present: {
              label: "Source image",
              required: false,
            },
          },
        },
        media_fallbacks: [
          {
            kind: "dummy",
            node_id: "167",
            input_type: "image",
            when: {
              kind: "input_presence",
              inputs: ["167"],
              match: "all_missing",
            },
          },
        ],
      }),
    });

    await useGenerationStore.getState().submitGeneration({});

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: "wf.json",
        workflowRules: expect.objectContaining({
          media_fallbacks: [
            expect.objectContaining({
              kind: "dummy",
              node_id: "167",
              input_type: "image",
            }),
          ],
          nodes: expect.objectContaining({
            "167": expect.objectContaining({
              present: expect.objectContaining({
                label: "Source image",
                required: false,
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("dispatches queued generations with the workflow rules captured at queue time", async () => {
    makeReadyStoreState();

    const queuedRules = makeWorkflowRules({
      nodes: {
        "235": {
          widgets: {
            switch: {
              label: "Use custom audio",
              hidden: true,
              value_type: "boolean",
            },
          },
        },
      },
    });
    const switchedRules = makeWorkflowRules({
      nodes: {
        "269": {
          present: {
            label: "Source image",
            required: false,
          },
        },
      },
    });

    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_flf2v.json",
      availableWorkflows: [
        { id: "video_ltx2_3_flf2v.json", name: "LTX2.3 FLF2V" },
        { id: "video_ltx2_3_i2v.json", name: "LTX2.3 I2V / T2V" },
      ],
      activeWorkflowRules: queuedRules,
      rulesWorkflowSourceId: "video_ltx2_3_flf2v.json",
      editorRef: {} as HTMLIFrameElement,
      jobs: new Map([
        [
          "active-job",
          {
            ...makeQueuedJob("active-job"),
            status: "running",
          },
        ],
      ]),
      activeJobId: "active-job",
    });

    await useGenerationStore.getState().queueGeneration({});

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);

    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_i2v.json",
      activeWorkflowRules: switchedRules,
      rulesWorkflowSourceId: "video_ltx2_3_i2v.json",
      activeJobId: null,
    });

    await useGenerationStore.getState().processGenerationQueue();

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: "video_ltx2_3_flf2v.json",
        workflowRules: expect.objectContaining({
          nodes: expect.objectContaining({
            "235": expect.objectContaining({
              widgets: expect.objectContaining({
                switch: expect.objectContaining({
                  label: "Use custom audio",
                }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(
      mockGenerate.mock.calls[0]?.[0]?.workflowRules?.nodes,
    ).not.toHaveProperty("269");
  });

  it("captures the queued pre-resolved workflow snapshot at queue time before switching workflows", async () => {
    makeReadyStoreState();

    const queuedWorkflowId = "video_ltx2_3_retake.json";
    const switchedWorkflowId = "video_ltx2_3_i2v.json";
    const queuedCapturedWorkflow = {
      "202": {
        class_type: "QueuedCapturedWorkflow",
        inputs: {
          prompt: "preserved-queued-workflow",
        },
      },
    };
    const switchedCapturedWorkflow = {
      "303": {
        class_type: "SwitchedCapturedWorkflow",
        inputs: {
          prompt: "incorrect-switched-workflow",
        },
      },
    };

    const queuedRules = makeWorkflowRules({
      nodes: {
        "235": {
          widgets: {
            switch: {
              label: "Use custom audio",
              hidden: true,
              value_type: "boolean",
            },
          },
        },
      },
    });
    const switchedRules = makeWorkflowRules({
      nodes: {
        "269": {
          present: {
            label: "Source image",
            required: false,
          },
        },
      },
    });

    mockPreResolvePrompt.mockImplementation(async () => ({
      output:
        useGenerationStore.getState().selectedWorkflowId === queuedWorkflowId
          ? queuedCapturedWorkflow
          : switchedCapturedWorkflow,
      workflow: {},
    }));

    useGenerationStore.setState({
      selectedWorkflowId: queuedWorkflowId,
      availableWorkflows: [
        { id: queuedWorkflowId, name: "LTX2.3 ReTake" },
        { id: switchedWorkflowId, name: "LTX2.3 I2V" },
      ],
      syncedWorkflow: {
        "1": {
          class_type: "OriginalQueuedWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: queuedRules,
      rulesWorkflowSourceId: queuedWorkflowId,
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
      jobs: new Map([
        [
          "active-job",
          {
            ...makeQueuedJob("active-job"),
            status: "running",
          },
        ],
      ]),
      activeJobId: "active-job",
    });

    await useGenerationStore.getState().queueGeneration({});

    const queuedPlan = useGenerationStore.getState().generationQueue[0];
    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(queuedPlan?.workflow.submittedWorkflow).toEqual(
      queuedCapturedWorkflow,
    );
    expect(queuedPlan?.workflow.promptIsPreResolved).toBe(true);

    useGenerationStore.setState({
      selectedWorkflowId: switchedWorkflowId,
      syncedWorkflow: {
        "2": {
          class_type: "SwitchedWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: switchedRules,
      rulesWorkflowSourceId: switchedWorkflowId,
      activeJobId: null,
    });

    await useGenerationStore.getState().processGenerationQueue();

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: queuedWorkflowId,
        workflow: queuedCapturedWorkflow,
        promptIsPreResolved: true,
        workflowRules: expect.objectContaining({
          nodes: expect.objectContaining({
            "235": expect.any(Object),
          }),
        }),
      }),
    );
    expect(
      mockGenerate.mock.calls[0]?.[0]?.workflowRules?.nodes,
    ).not.toHaveProperty("269");
  });

  it("reuses prepared media when only text and seed inputs change", async () => {
    makeReadyStoreState();
    const sourceVideo = makeTestFile("video", "source.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });
    const preparedVideo = makeTestFile("prepared", "prepared.mp4", {
      type: "video/mp4",
      lastModified: 2,
    });

    useGenerationStore.setState({
      syncedWorkflow: {
        "10": {
          class_type: "CLIPTextEncode",
          inputs: {
            text: "",
          },
        },
        "20": {
          class_type: "LoadVideo",
          inputs: {
            file: "",
          },
        },
        "115": {
          class_type: "RandomNoise",
          inputs: {
            noise_seed: 1,
          },
        },
      },
      workflowInputs: [
        makeWorkflowInput({
          id: "prompt",
          nodeId: "10",
          inputType: "text",
          param: "text",
        }),
        makeWorkflowInput({
          id: "source",
          nodeId: "20",
          inputType: "video",
          param: "file",
        }),
      ],
    });
    mockFrontendPreprocess.mockImplementation(
      async (
        syncedWorkflow: Record<string, unknown> | null,
        workflowId: string | null,
        _workflowRules: unknown,
        workflowInputs: WorkflowInput[],
        slotValues: Record<string, import("../pipeline/types").SlotValue>,
        clientId: string,
      ) => {
        const textInput = workflowInputs.find((input) => input.inputType === "text");
        const promptValue = slotValues.prompt;
        return {
          workflow: syncedWorkflow,
          workflowId,
          targetAspectRatio: "16:9",
          exactAspectRatio: false,
          targetResolution: 1080,
          textInputs:
            textInput && promptValue?.type === "text"
              ? { [textInput.nodeId]: promptValue.value }
              : {},
          imageInputs: {},
          audioInputs: {},
          videoInputs: {
            "20": preparedVideo,
          },
          pipelineInputs: {
            aspect_ratio: {
              target_aspect_ratio: "16:9",
              target_resolution: 1080,
            },
          },
          clientId,
        };
      },
    );
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
        comfyui_prompt: {
          "20": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-source.mp4",
            },
          },
        },
        pipeline_outputs: {
          mask_processing: {
            mask_crop_metadata: {
              mode: "full",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
        comfyui_prompt: {
          "10": {
            class_type: "CLIPTextEncode",
            inputs: {
              text: "second prompt",
            },
          },
          "20": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-source.mp4",
            },
          },
          "115": {
            class_type: "RandomNoise",
            inputs: {
              noise_seed: 456,
            },
          },
        },
      });

    await useGenerationStore.getState().submitGeneration(
      {
        prompt: {
          type: "text",
          value: "first prompt",
        },
        source: {
          type: "video",
          file: sourceVideo,
        },
      },
      {
        widget_115_noise_seed: "123",
      },
    );
    useGenerationStore.setState({ activeJobId: null });

    await useGenerationStore.getState().submitGeneration(
      {
        prompt: {
          type: "text",
          value: "second prompt",
        },
        source: {
          type: "video",
          file: sourceVideo,
        },
      },
      {
        widget_115_noise_seed: "456",
      },
    );

    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        textInputs: {
          "10": "second prompt",
        },
        // Prepared media stays attached to cached reruns so the backend can
        // recover from stale ComfyUI memory-loader ids.
        videoInputs: {
          "20": preparedVideo,
        },
        cachedMediaInputs: {
          "20": {
            file: "cached-source.mp4",
          },
        },
        widgetInputs: {
          widget_115_noise_seed: "456",
        },
      }),
    );
  });

  it("treats cached media inputs as present during pre-resolve reruns", async () => {
    makeReadyStoreState();
    const sourceFrame = makeTestFile("frame", "source.png", {
      type: "image/png",
      lastModified: 1,
    });

    useGenerationStore.setState({
      syncedWorkflow: {
        "92": {
          class_type: "VLOMemoryLoadImage",
          inputs: {
            image: "",
          },
        },
      },
      workflowInputs: [
        makeWorkflowInput({
          nodeId: "92",
          classType: "VLOMemoryLoadImage",
          inputType: "image",
          param: "image",
          label: "Start frame",
        }),
      ],
      activeWorkflowRules: makeWorkflowRules({
        rewrites: [
          {
            when: {
              kind: "input_presence",
              inputs: ["92"],
              match: "all_missing",
            },
            bypass: ["92"],
          },
        ],
      }),
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    mockFrontendPreprocess.mockResolvedValueOnce({
      workflow: {
        "92": {
          class_type: "VLOMemoryLoadImage",
          inputs: {
            image: "",
          },
        },
      },
      workflowId: "wf.json",
      targetAspectRatio: "16:9",
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {
        "92": sourceFrame,
      },
      audioInputs: {},
      videoInputs: {},
      pipelineInputs: {},
      clientId: "client-id",
    });
    mockPreResolvePrompt.mockResolvedValue({
      output: {
        "101": {
          class_type: "CapturedPreResolvedWorkflow",
          inputs: {},
        },
      },
      workflow: {},
    });
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
        comfyui_prompt: {
          "92": {
            class_type: "VLOMemoryLoadImage",
            inputs: {
              image: "cached-frame.png",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
        comfyui_prompt: {
          "92": {
            class_type: "VLOMemoryLoadImage",
            inputs: {
              image: "cached-frame.png",
            },
          },
        },
      });

    await useGenerationStore.getState().submitGeneration({
      "92": {
        type: "image",
        file: sourceFrame,
      },
    });
    useGenerationStore.setState({ activeJobId: null });

    await useGenerationStore.getState().submitGeneration({
      "92": {
        type: "image",
        file: sourceFrame,
      },
    });

    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        // Prepared media stays attached to cached reruns so the backend can
        // recover from stale ComfyUI memory-loader ids.
        imageInputs: {
          "92": sourceFrame,
        },
        cachedMediaInputs: {
          "92": {
            image: "cached-frame.png",
          },
        },
      }),
    );
    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(2);
    expect(mockPreResolvePrompt.mock.calls[1]?.[0]).not.toContain("92");
  });

  it("reruns media preprocessing when the source file changes", async () => {
    makeReadyStoreState();
    const firstVideo = makeTestFile("video-a", "source.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });
    const secondVideo = makeTestFile("video-b", "source.mp4", {
      type: "video/mp4",
      lastModified: 2,
    });
    const workflowInputs = [
      makeWorkflowInput({
        id: "source",
        nodeId: "20",
        inputType: "video",
        param: "file",
      }),
    ];
    useGenerationStore.setState({
      syncedWorkflow: {
        "20": {
          class_type: "LoadVideo",
          inputs: {
            file: "",
          },
        },
      },
      workflowInputs,
    });
    mockFrontendPreprocess.mockImplementation(
      async (
        syncedWorkflow: Record<string, unknown> | null,
        workflowId: string | null,
        _workflowRules: unknown,
        _workflowInputs: WorkflowInput[],
        slotValues: Record<string, import("../pipeline/types").SlotValue>,
        clientId: string,
      ) => ({
        workflow: syncedWorkflow,
        workflowId,
        targetAspectRatio: "16:9",
        exactAspectRatio: false,
        targetResolution: 1080,
        textInputs: {},
        imageInputs: {},
        audioInputs: {},
        videoInputs: {
          "20": slotValues.source?.type === "video" ? slotValues.source.file : firstVideo,
        },
        pipelineInputs: {},
        clientId,
      }),
    );
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
        comfyui_prompt: {
          "20": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-source-a.mp4",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
        comfyui_prompt: {
          "20": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-source-b.mp4",
            },
          },
        },
      });

    await useGenerationStore.getState().submitGeneration({
      source: {
        type: "video",
        file: firstVideo,
      },
    });
    useGenerationStore.setState({ activeJobId: null });

    await useGenerationStore.getState().submitGeneration({
      source: {
        type: "video",
        file: secondVideo,
      },
    });

    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[1]?.[0]?.cachedMediaInputs).toBeUndefined();
    expect(mockGenerate.mock.calls[1]?.[0]?.videoInputs).toEqual({
      "20": secondVideo,
    });
  });

  it("captures every workflow's pre-resolved prompt before preprocessing starts", async () => {
    makeReadyStoreState();
    const preprocessDeferred = createDeferred<{
      workflow: Record<string, unknown> | null;
      workflowId: string | null;
      targetAspectRatio: string;
      exactAspectRatio: boolean;
      targetResolution: number;
      textInputs: Record<string, string>;
      imageInputs: Record<string, File>;
      audioInputs: Record<string, File>;
      videoInputs: Record<string, File>;
      clientId: string;
    }>();
    mockFrontendPreprocess.mockReturnValue(preprocessDeferred.promise);

    const queuedRules = makeWorkflowRules({
      nodes: {
        "167": {
          present: {
            label: "Source image",
            required: false,
          },
        },
      },
    });
    const switchedRules = makeWorkflowRules({
      nodes: {
        "269": {
          present: {
            label: "Source video",
            required: false,
          },
        },
      },
    });

    mockPreResolvePrompt.mockResolvedValueOnce({
      output: {
        "101": {
          class_type: "CapturedPreResolvedWorkflow",
          inputs: {
            prompt: "captured-before-preprocess",
          },
        },
      },
      workflow: {},
    });

    useGenerationStore.setState({
      selectedWorkflowId: "unmigrated-workflow.json",
      availableWorkflows: [
        { id: "unmigrated-workflow.json", name: "Unmigrated Workflow" },
        { id: "wf-switched.json", name: "Switched Workflow" },
      ],
      syncedWorkflow: {
        "1": {
          class_type: "OriginalWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: queuedRules,
      rulesWorkflowSourceId: "unmigrated-workflow.json",
      editorRef: {} as HTMLIFrameElement,
      // Re-enable for the test that exercises the graphToPrompt-based
      // submission capture; makeReadyStoreState defaults to disabled.
      preResolvedPromptEnabled: true,
    });

    const submitPromise = useGenerationStore.getState().submitGeneration({});
    await flushMicrotasks();

    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(1);
    expect(mockPreResolvePrompt).not.toHaveBeenCalled();

    useGenerationStore.setState({
      selectedWorkflowId: "wf-switched.json",
      syncedWorkflow: {
        "2": {
          class_type: "SwitchedWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: switchedRules,
      rulesWorkflowSourceId: "wf-switched.json",
    });

    preprocessDeferred.resolve({
      workflow: {
        "1": {
          class_type: "OriginalWorkflow",
          inputs: {},
        },
      },
      workflowId: "unmigrated-workflow.json",
      targetAspectRatio: "16:9",
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      clientId: "client-id",
    });

    await submitPromise;

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: "unmigrated-workflow.json",
        workflow: {
          "101": {
            class_type: "CapturedPreResolvedWorkflow",
            inputs: {
              prompt: "captured-before-preprocess",
            },
          },
        },
        promptIsPreResolved: true,
        workflowRules: expect.objectContaining({
          nodes: expect.objectContaining({
            "167": expect.any(Object),
          }),
        }),
      }),
    );
    expect(
      mockGenerate.mock.calls[0]?.[0]?.workflowRules?.nodes,
    ).not.toHaveProperty("269");
  });

  it("passes empty manual media nodes through the pre-resolve bypass list", async () => {
    makeReadyStoreState();

    useGenerationStore.setState({
      syncedWorkflow: {
        "62": {
          class_type: "LoadImage",
          inputs: {
            image: "default.png",
          },
        },
      },
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    await useGenerationStore
      .getState()
      .submitGeneration({}, {}, {}, {}, {}, ["62"]);

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mockPreResolvePrompt.mock.calls[0]?.[1]).toEqual(["62"]);
  });

  it("keeps optional derived mask nodes out of the bypass list when preprocess uploaded a mask", async () => {
    makeReadyStoreState();

    useGenerationStore.setState({
      syncedWorkflow: {
        "644": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: {},
        },
        "689": {
          class_type: "LoadVideo",
          inputs: {},
        },
      },
      workflowInputs: [
        {
          nodeId: "644",
          classType: "VHS_LoadVideoFFmpeg",
          inputType: "video",
          param: "video",
          label: "Source video",
          currentValue: null,
          origin: "rule",
        },
      ],
      activeWorkflowRules: makeWorkflowRules({
        rewrites: [
          {
            when: {
              kind: "input_presence",
              inputs: ["689"],
              match: "all_missing",
            },
            bypass: ["689", "693", "694", "703", "708"],
          },
        ],
      }),
      derivedMaskMappings: [
        {
          sourceNodeId: "644",
          maskNodeId: "689",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    mockFrontendPreprocess.mockResolvedValueOnce({
      workflow: {
        "644": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: {},
        },
      },
      workflowId: "wf.json",
      targetAspectRatio: "16:9",
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {
        "644": new File(["video"], "selection.mp4", { type: "video/mp4" }),
        "689": new File(["mask"], "selection-mask.mp4", {
          type: "video/mp4",
        }),
      },
      clientId: "client-id",
    });
    mockPreResolvePrompt.mockResolvedValueOnce({
      output: {
        "101": {
          class_type: "CapturedPreResolvedWorkflow",
          inputs: {},
        },
      },
      workflow: {},
    });

    await useGenerationStore.getState().submitGeneration({
      "644": {
        type: "video",
        file: new File(["video"], "source.mp4", { type: "video/mp4" }),
      },
    });

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mockPreResolvePrompt.mock.calls[0]?.[1]).not.toContain("689");
    expect(mockPreResolvePrompt.mock.calls[0]?.[1]).not.toContain("693");
  });

  it("re-resolves a queued generation once preprocess uploads a derived mask", async () => {
    makeReadyStoreState();

    useGenerationStore.setState({
      syncedWorkflow: {
        "644": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: {},
        },
        "689": {
          class_type: "LoadVideo",
          inputs: {},
        },
      },
      workflowInputs: [
        {
          nodeId: "644",
          classType: "VHS_LoadVideoFFmpeg",
          inputType: "video",
          param: "video",
          label: "Source video",
          currentValue: null,
          origin: "rule",
        },
      ],
      activeWorkflowRules: makeWorkflowRules({
        rewrites: [
          {
            when: {
              kind: "input_presence",
              inputs: ["689"],
              match: "all_missing",
            },
            bypass: ["689", "693", "694", "703", "708"],
          },
        ],
      }),
      derivedMaskMappings: [
        {
          sourceNodeId: "644",
          maskNodeId: "689",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    mockFrontendPreprocess.mockResolvedValueOnce({
      workflow: {
        "644": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: {},
        },
      },
      workflowId: "wf.json",
      targetAspectRatio: "16:9",
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {
        "644": new File(["video"], "selection.mp4", { type: "video/mp4" }),
        "689": new File(["mask"], "selection-mask.mp4", {
          type: "video/mp4",
        }),
      },
      clientId: "client-id",
    });

    await useGenerationStore.getState().queueGeneration({
      "644": {
        type: "video",
        file: new File(["video"], "source.mp4", { type: "video/mp4" }),
      },
    });

    // The enqueue-time capture cannot know the mask preprocessing will
    // render, so it bypasses node 689; the dispatch capture must correct that
    // rather than submit the stale prompt.
    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(2);
    expect(mockPreResolvePrompt.mock.calls[0]?.[1]).toContain("689");
    const lastBypass = mockPreResolvePrompt.mock.calls[1]?.[1];
    expect(lastBypass).not.toContain("689");
    expect(lastBypass).not.toContain("693");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]?.promptIsPreResolved).toBe(true);
  });

  it("refuses to submit when the bridge reports workflow revision drift", async () => {
    makeReadyStoreState();

    const expectedGraphData = {
      "100": { class_type: "ExpectedNode", inputs: {} },
      "101": { class_type: "AnotherExpectedNode", inputs: {} },
    };
    mockPreResolvePrompt.mockRejectedValueOnce(
      new Error("The ComfyUI workflow changed before prompt resolution"),
    );

    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      rulesWorkflowSourceId: "wf.json",
      syncedGraphData: expectedGraphData,
      syncedWorkflow: expectedGraphData,
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    try {
      await useGenerationStore.getState().submitGeneration({});

      expect(mockPreResolvePrompt).toHaveBeenCalledWith(
        { workflowInstanceId: "workflow-instance", revision: 0 },
        expect.any(Array),
        expect.any(Array),
      );
      expect(mockGenerate).not.toHaveBeenCalled();

      const state = useGenerationStore.getState();
      const errorJob = state.activeJobId
        ? state.jobs.get(state.activeJobId)
        : null;
      expect(errorJob?.status).toBe("error");
      expect(errorJob?.error ?? "").toContain("workflow changed");
    } finally {
      // The store has no global beforeEach reset, and this test mutates state
      // (editorRef, syncedGraphData, error job) that subsequent tests don't
      // overwrite via makeReadyStoreState. Clean up explicitly so we don't
      // bleed into queue-dispatch tests further down the file.
      useGenerationStore.setState({
        editorRef: null,
        preResolvedPromptEnabled: false,
        syncedGraphData: null,
        jobs: new Map(),
        activeJobId: null,
      });
    }
  });

  it("submits from the synchronized workflow instance and revision", async () => {
    makeReadyStoreState();

    const panelGraphData = {
      "100": { class_type: "MatchingNode", inputs: { value: 1 } },
    };
    // Same filename, slightly different widget value — should NOT trip the
    // guard. We rely on filename match for this case.
    const iframeGraphData = {
      "100": { class_type: "MatchingNode", inputs: { value: 999 } },
    };

    mockBridgeReadActive.mockResolvedValue({
      graphData: iframeGraphData,
      filename: "wf.json",
      isModified: false,
    });

    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      rulesWorkflowSourceId: "wf.json",
      syncedGraphData: panelGraphData,
      syncedWorkflow: panelGraphData,
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
    });

    try {
      await useGenerationStore.getState().submitGeneration({});

      expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    } finally {
      useGenerationStore.setState({
        editorRef: null,
        preResolvedPromptEnabled: false,
        syncedGraphData: null,
        jobs: new Map(),
        activeJobId: null,
      });
    }
  });

  it("uses the queued pre-resolved workflow snapshot instead of the live editor workflow at dispatch time", async () => {
    makeReadyStoreState();

    const queuedRules = makeWorkflowRules({
      nodes: {
        "235": {
          widgets: {
            switch: {
              label: "Use custom audio",
              hidden: true,
              value_type: "boolean",
            },
          },
        },
      },
    });
    const switchedRules = makeWorkflowRules({
      nodes: {
        "269": {
          present: {
            label: "Source image",
            required: false,
          },
        },
      },
    });

    mockPreResolvePrompt.mockResolvedValueOnce({
      output: {
        "202": {
          class_type: "QueuedCapturedWorkflow",
          inputs: {
            prompt: "preserved-queued-workflow",
          },
        },
      },
      workflow: {},
    });

    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_retake.json",
      availableWorkflows: [
        { id: "video_ltx2_3_retake.json", name: "LTX2.3 ReTake" },
        { id: "video_ltx2_3_i2v.json", name: "LTX2.3 I2V" },
      ],
      syncedWorkflow: {
        "1": {
          class_type: "OriginalQueuedWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: queuedRules,
      rulesWorkflowSourceId: "video_ltx2_3_retake.json",
      editorRef: {} as HTMLIFrameElement,
      preResolvedPromptEnabled: true,
      jobs: new Map([
        [
          "active-job",
          {
            ...makeQueuedJob("active-job"),
            status: "running",
          },
        ],
      ]),
      activeJobId: "active-job",
    });

    await useGenerationStore.getState().queueGeneration({});

    const queuedPlan = useGenerationStore.getState().generationQueue[0];
    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(queuedPlan?.workflow.submittedWorkflow).toEqual({
      "202": {
        class_type: "QueuedCapturedWorkflow",
        inputs: {
          prompt: "preserved-queued-workflow",
        },
      },
    });
    expect(queuedPlan?.workflow.promptIsPreResolved).toBe(true);
    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);

    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_i2v.json",
      syncedWorkflow: {
        "2": {
          class_type: "SwitchedWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: switchedRules,
      rulesWorkflowSourceId: "video_ltx2_3_i2v.json",
      activeJobId: null,
    });

    await useGenerationStore.getState().processGenerationQueue();

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: "video_ltx2_3_retake.json",
        workflow: {
          "202": {
            class_type: "QueuedCapturedWorkflow",
            inputs: {
              prompt: "preserved-queued-workflow",
            },
          },
        },
        promptIsPreResolved: true,
        workflowRules: expect.objectContaining({
          nodes: expect.objectContaining({
            "235": expect.any(Object),
          }),
        }),
      }),
    );
    expect(
      mockGenerate.mock.calls[0]?.[0]?.workflowRules?.nodes,
    ).not.toHaveProperty("269");
  });

  it("cancels preprocess locally, ignores stale completion, and leaves no error job", async () => {
    makeReadyStoreState();
    const preprocessDeferred = createDeferred<{
      workflow: Record<string, unknown> | null;
      workflowId: string | null;
      targetAspectRatio: string;
      exactAspectRatio: boolean;
      targetResolution: number;
      textInputs: Record<string, string>;
      imageInputs: Record<string, File>;
      audioInputs: Record<string, File>;
      videoInputs: Record<string, File>;
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
      exactAspectRatio: false,
      targetResolution: 1080,
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      clientId: "client-id",
    });

    const jobId = await submitPromise;
    expect(jobId).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(useGenerationStore.getState().pipelineStatus.phase).toBe("idle");
    expect(useGenerationStore.getState().jobs.size).toBe(0);
  });

  it("queues generations when graph snapshots include non-serializable browser values", async () => {
    const isBrowserEnv =
      typeof window !== "undefined" && typeof document !== "undefined";
    const expectedTransientSelection = isBrowserEnv ? [null, null] : [null];
    makeReadyStoreState();
    const nonSerializableArray = isBrowserEnv
      ? [window, document.body]
      : [() => "noop"];

    useGenerationStore.setState({
      syncedGraphData: {
        nodes: [],
        viewport: {
          zoom: 1,
        },
        transientSelection: nonSerializableArray,
      },
    });

    await expect(
      useGenerationStore.getState().queueGeneration({}, {}, {}, {}, 1),
    ).resolves.toBeUndefined();

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockFrontendPreprocess).toHaveBeenCalledWith(
      {},
      "wf.json",
      expect.any(Object),
      [],
      {},
      "client-id",
      [],
      0.1,
      expect.objectContaining({
        maskCropMode: "crop",
        targetResolution: 1080,
      }),
      {
        nodes: [],
        viewport: {
          zoom: 1,
        },
        transientSelection: expectedTransientSelection,
      },
    );
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

  it("tracks ComfyUI's global queue depth from status broadcasts", async () => {
    useGenerationStore.getState().connect();
    const client = getLatestClient();
    expect(useGenerationStore.getState().comfyQueueRemaining).toBeNull();

    client.emitEvent({
      type: "status",
      data: { status: { exec_info: { queue_remaining: 3 } } },
    });
    await flushMicrotasks();

    expect(useGenerationStore.getState().comfyQueueRemaining).toBe(3);
  });

  it("replaces the delivery connection when the active project changes", () => {
    useGenerationStore.getState().connect();
    const firstDeliveryClient = getLatestDeliveryClient();
    const currentProject = useProjectStore.getState().project;
    expect(currentProject).not.toBeNull();
    expect(firstDeliveryClient.boundProjectId).toBe("project-1");

    useProjectStore.setState({
      project: {
        ...currentProject!,
        id: "project-2",
        title: "Project Two",
      },
    });
    useGenerationStore.getState().connect();

    const secondDeliveryClient = getLatestDeliveryClient();
    expect(mockDeliveryWsInstances).toHaveLength(2);
    expect(firstDeliveryClient.isConnected).toBe(false);
    expect(secondDeliveryClient.boundProjectId).toBe("project-2");
    expect(secondDeliveryClient.isConnected).toBe(true);
  });

  it("keeps websocket preview frames ordered by explicit frame index", async () => {
    if (!("createObjectURL" in URL)) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:preview"),
      });
    } else {
      vi.spyOn(URL, "createObjectURL").mockImplementation(
        () => "blob:preview",
      );
    }
    if (!("revokeObjectURL" in URL)) {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }

    const previewJob = {
      ...makeQueuedJob("prompt-preview"),
      status: "running" as const,
      currentNode: "save_ws_node",
      usesSaveImageWebsocketOutputs: true,
      saveImageWebsocketNodeIds: new Set(["save_ws_node"]),
    };

    useGenerationStore.setState({
      jobs: new Map([[previewJob.id, previewJob]]),
      jobPreviewFrames: new Map([[previewJob.id, []]]),
      activeJobId: previewJob.id,
    });

    useGenerationStore.getState().connect();
    const deliveryClient = getLatestDeliveryClient();

    deliveryClient.emitPreview({
      blob: new Blob(["frame-2"], { type: "image/jpeg" }),
      frameIndex: 2,
    });
    deliveryClient.emitPreview({
      blob: new Blob(["frame-0"], { type: "image/jpeg" }),
      frameIndex: 0,
    });

    const previewFrames =
      useGenerationStore.getState().jobPreviewFrames.get(previewJob.id) ?? [];

    expect(previewFrames[0]?.name).toContain("000000.jpg");
    expect(previewFrames[2]?.name).toContain("000002.jpg");
    expect(previewFrames[0]?.type).toBe("image/jpeg");
    expect(previewFrames[2]?.type).toBe("image/jpeg");
    expect(previewFrames[0]?.size).toBe(7);
    expect(previewFrames[2]?.size).toBe(7);
  });

  it("clears the animation buffer when a plain preview arrives after VHS frames", () => {
    const objectUrlValues = [
      "blob:latest-vhs",
      "blob:vhs-frame-1",
      "blob:latest-plain",
    ];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const nextValue = objectUrlValues.shift();
      if (!nextValue) {
        throw new Error("Expected another object URL value");
      }
      return nextValue;
    });
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    const previewJob = {
      ...makeQueuedJob("prompt-preview-animation"),
      status: "running" as const,
    };

    useGenerationStore.setState({
      jobs: new Map([[previewJob.id, previewJob]]),
      activeJobId: previewJob.id,
    });

    useGenerationStore.getState().connect();
    const deliveryClient = getLatestDeliveryClient();

    deliveryClient.emitPreview({
      blob: new Blob(["vhs-frame"], { type: "image/png" }),
      frameIndex: 1,
      frameRate: 8,
      totalFrames: 4,
    });

    const animationState = useGenerationStore.getState();
    expect(animationState.previewAnimation?.frameUrls[1]).toBe("blob:vhs-frame-1");

    deliveryClient.emitPreview({
      blob: new Blob(["plain-preview"], { type: "image/png" }),
    });

    const finalState = useGenerationStore.getState();
    expect(finalState.previewAnimation).toBeNull();
    expect(finalState.latestPreviewUrl).toBe("blob:latest-plain");
    expect(revokeSpy).toHaveBeenCalledWith("blob:vhs-frame-1");
  });

  it("allows new submissions while postprocessing is active", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      postprocessingJobIds: ["prompt-post"],
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});

    expect(jobId).toBe("prompt-1");
    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("clears stale live previews when a new generation starts", async () => {
    makeReadyStoreState();
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    useGenerationStore.setState({
      latestPreviewUrl: "blob:stale-preview",
      previewAnimation: {
        frameUrls: ["blob:stale-frame"],
        frameRate: 8,
        totalFrames: 1,
      },
    });

    const jobId = await useGenerationStore.getState().submitGeneration({});

    expect(jobId).toBe("prompt-1");
    expect(useGenerationStore.getState()).toMatchObject({
      activeJobId: "prompt-1",
      latestPreviewUrl: null,
      previewAnimation: null,
    });
    expect(revokeSpy).toHaveBeenCalledWith("blob:stale-preview");
    expect(revokeSpy).toHaveBeenCalledWith("blob:stale-frame");
  });

  it("clears queued future generations before interrupting the active one", async () => {
    const runningJob = {
      ...makeQueuedJob("prompt-running"),
      status: "running" as const,
    };
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      generationQueue: [
        {
          id: "queued-1",
          createdAt: Date.now(),
          workflow: {
            workflow: {},
            graphData: null,
            workflowId: "wf.json",
            workflowRules: null,
            workflowInputs: [],
          },
          preprocess: {
            slotValues: {},
            derivedMaskMappings: [],
            projectConfig: {
              aspectRatio: "16:9",
              fps: 24,
            },
            exactAspectRatio: false,
            targetResolution: 1080,
            maskCropMode: "crop",
            maskCropDilation: 0.1,
          },
          submission: {
            widgetInputs: {},
            frontendStateWidgetValues: {},
            inputMetadata: {},
            widgetModes: {},
            derivedWidgetInputs: {},
            bypassNodeIds: [],
          },
          metadata: {
            generationMetadata: {
              source: "generated",
              workflowName: "Workflow Display Name",
              inputs: [],
              targetResolution: 1080,
            },
            workflowWarnings: [],
          },
          postprocess: {
            config: {
              mode: "auto",
              panel_preview: "raw_outputs",
              on_failure: "fallback_raw",
            },
          },
          effects: null,
        },
      ],
    });

    await useGenerationStore.getState().cancelGeneration();

    expect(useGenerationStore.getState().generationQueue).toHaveLength(0);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
  });

  it("interrupts the active generation without clearing queued future generations", async () => {
    const runningJob = {
      ...makeQueuedJob("prompt-running"),
      status: "running" as const,
    };
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      wsClient: null,
      connectionStatus: "disconnected",
      generationQueue: [
        {
          id: "queued-1",
          createdAt: Date.now(),
          workflow: {
            workflow: {},
            graphData: null,
            workflowId: "wf.json",
            workflowRules: null,
            workflowInputs: [],
          },
          preprocess: {
            slotValues: {},
            derivedMaskMappings: [],
            projectConfig: {
              aspectRatio: "16:9",
              fps: 24,
            },
            exactAspectRatio: false,
            targetResolution: 1080,
            maskCropMode: "crop",
            maskCropDilation: 0.1,
          },
          submission: {
            widgetInputs: {},
            frontendStateWidgetValues: {},
            inputMetadata: {},
            widgetModes: {},
            derivedWidgetInputs: {},
            bypassNodeIds: [],
          },
          metadata: {
            generationMetadata: {
              source: "generated",
              workflowName: "Workflow Display Name",
              inputs: [],
              targetResolution: 1080,
            },
            workflowWarnings: [],
          },
          postprocess: {
            config: {
              mode: "auto",
              panel_preview: "raw_outputs",
              on_failure: "fallback_raw",
            },
          },
          effects: null,
        },
      ],
    });

    await useGenerationStore.getState().interruptCurrentGeneration();

    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
  });

  it("clears queued future generations without interrupting the active one", () => {
    const runningJob = {
      ...makeQueuedJob("prompt-running"),
      status: "running" as const,
    };
    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      generationQueue: [
        {
          id: "queued-1",
          createdAt: Date.now(),
          workflow: {
            workflow: {},
            graphData: null,
            workflowId: "wf.json",
            workflowRules: null,
            workflowInputs: [],
          },
          preprocess: {
            slotValues: {},
            derivedMaskMappings: [],
            projectConfig: {
              aspectRatio: "16:9",
              fps: 24,
            },
            exactAspectRatio: false,
            targetResolution: 1080,
            maskCropMode: "crop",
            maskCropDilation: 0.1,
          },
          submission: {
            widgetInputs: {},
            frontendStateWidgetValues: {},
            inputMetadata: {},
            widgetModes: {},
            derivedWidgetInputs: {},
            bypassNodeIds: [],
          },
          metadata: {
            generationMetadata: {
              source: "generated",
              workflowName: "Workflow Display Name",
              inputs: [],
              targetResolution: 1080,
            },
            workflowWarnings: [],
          },
          postprocess: {
            config: {
              mode: "auto",
              panel_preview: "raw_outputs",
              on_failure: "fallback_raw",
            },
          },
          effects: null,
        },
      ],
    });

    useGenerationStore.getState().clearGenerationQueue();

    const state = useGenerationStore.getState();
    expect(state.generationQueue).toHaveLength(0);
    expect(state.activeJobId).toBe(runningJob.id);
    expect(mockInterrupt).not.toHaveBeenCalled();
  });
});
