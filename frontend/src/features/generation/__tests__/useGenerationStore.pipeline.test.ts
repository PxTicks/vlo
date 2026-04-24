import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob, WorkflowInput } from "../types";
import {
  createDefaultWorkflowRules,
  type WorkflowRules,
} from "../services/workflowRules";
import { useProjectStore } from "../../project";

const {
  mockDeliveryWsInstances,
  mockFrontendPostprocess,
  mockFrontendPreprocess,
  mockGenerate,
  mockGetConfig,
  mockGetPromptHistoryStateWithRetry,
  mockGetQueue,
  mockGetRuntimeStatus,
  mockGetHistoryOutputsWithRetry,
  mockInterrupt,
  mockListWorkflows,
  mockPreResolvePrompt,
  mockWsInstances,
} = vi.hoisted(() => ({
  mockDeliveryWsInstances: [] as unknown[],
  mockFrontendPostprocess: vi.fn(),
  mockFrontendPreprocess: vi.fn(),
  mockGenerate: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetPromptHistoryStateWithRetry: vi.fn(),
  mockGetQueue: vi.fn(),
  mockGetRuntimeStatus: vi.fn(),
  mockGetHistoryOutputsWithRetry: vi.fn(),
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
    isConnected = false;
    private readonly messageHandlers = new Set<(message: unknown) => void>();
    private readonly previewHandlers = new Set<(preview: unknown) => void>();
    private readonly connectionChangeHandlers = new Set<
      (state: "connected" | "disconnected") => void
    >();

    constructor(...args: [string, string]) {
      void args;
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
    getQueue: mockGetQueue,
    interrupt: mockInterrupt,
    listWorkflows: mockListWorkflows,
  };
});

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeStatus: mockGetRuntimeStatus,
}));

vi.mock("../store/history", () => ({
  getHistoryOutputsWithRetry: mockGetHistoryOutputsWithRetry,
  getPromptHistoryStateWithRetry: mockGetPromptHistoryStateWithRetry,
}));

vi.mock("../utils/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pipeline")>();
  return {
    ...actual,
    frontendPreprocess: mockFrontendPreprocess,
    frontendPostprocess: mockFrontendPostprocess,
  };
});

vi.mock("../services/preResolvePrompt", () => ({
  isGraphMutationInFlight: () => false,
  preResolvePrompt: mockPreResolvePrompt,
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

describe("useGenerationStore pipeline phases", () => {
  beforeEach(() => {
    mockWsInstances.length = 0;
    mockDeliveryWsInstances.length = 0;
    mockFrontendPreprocess.mockReset();
    mockFrontendPostprocess.mockReset();
    mockGenerate.mockReset();
    mockGetConfig.mockReset();
    mockGetPromptHistoryStateWithRetry.mockReset();
    mockGetQueue.mockReset();
    mockGetRuntimeStatus.mockReset();
    mockGetHistoryOutputsWithRetry.mockReset();
    mockInterrupt.mockReset();
    mockListWorkflows.mockReset();
    mockPreResolvePrompt.mockReset();

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
    mockGetHistoryOutputsWithRetry.mockResolvedValue([
      {
        filename: "output.png",
        subfolder: "",
        type: "output",
        viewUrl: "/output.png",
      },
    ]);
    mockGetPromptHistoryStateWithRetry.mockResolvedValue({
      hasPromptEntry: false,
      outputs: [],
    });
    mockGetQueue.mockResolvedValue({
      queue_running: [],
      queue_pending: [],
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

  it("reuses prepared media when only text and seed inputs change", async () => {
    makeReadyStoreState();
    const sourceVideo = makeTestFile("video", "source.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });
    const preparedVideo = makeTestFile("prepared", "prepared.webm", {
      type: "video/webm",
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
        videoInputs: {},
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

  it("reruns media preprocessing when mask source treatment changes", async () => {
    makeReadyStoreState();
    const preparedVideo = makeTestFile("prepared", "prepared.webm", {
      type: "video/webm",
      lastModified: 1,
    });
    const preparedMask = makeTestFile("mask", "mask.webm", {
      type: "video/webm",
      lastModified: 1,
    });
    const selection = {
      start: 0,
      end: 30,
      clips: [],
      fps: 30,
    };

    useGenerationStore.setState({
      syncedWorkflow: {
        "20": {
          class_type: "LoadVideo",
          inputs: {
            file: "",
          },
        },
        "21": {
          class_type: "LoadVideo",
          inputs: {
            file: "",
          },
        },
      },
      workflowInputs: [
        makeWorkflowInput({
          id: "source",
          nodeId: "20",
          inputType: "video",
          param: "file",
        }),
      ],
      derivedMaskMappings: [
        {
          sourceInputId: "source",
          sourceNodeId: "20",
          maskNodeId: "21",
          maskParam: "file",
          maskType: "binary",
        },
      ],
    });
    mockFrontendPreprocess.mockImplementation(
      async (
        syncedWorkflow: Record<string, unknown> | null,
        workflowId: string | null,
        _workflowRules: unknown,
        _workflowInputs: WorkflowInput[],
        _slotValues: Record<string, import("../pipeline/types").SlotValue>,
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
          "20": preparedVideo,
          "21": preparedMask,
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
              file: "cached-source.webm",
            },
          },
          "21": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-mask.webm",
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
              file: "cached-source.webm",
            },
          },
          "21": {
            class_type: "LoadVideo",
            inputs: {
              file: "cached-mask.webm",
            },
          },
        },
      });

    await useGenerationStore.getState().submitGeneration({
      source: {
        type: "video_selection",
        selection,
        preparedVideoFile: preparedVideo,
        preparedMaskFile: preparedMask,
        derivedMaskVideoTreatment: "remove_transparency",
        preparedDerivedMaskVideoTreatment: "remove_transparency",
      },
    });
    useGenerationStore.setState({ activeJobId: null });

    await useGenerationStore.getState().submitGeneration({
      source: {
        type: "video_selection",
        selection,
        preparedVideoFile: preparedVideo,
        preparedMaskFile: preparedMask,
        derivedMaskVideoTreatment: "preserve_transparency",
        preparedDerivedMaskVideoTreatment: "remove_transparency",
      },
    });

    expect(mockFrontendPreprocess).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[1]?.[0]?.cachedMediaInputs).toBeUndefined();
    expect(mockGenerate.mock.calls[1]?.[0]?.videoInputs).toEqual({
      "20": preparedVideo,
      "21": preparedMask,
    });
  });

  it("captures a migrated workflow's pre-resolved prompt before preprocessing starts", async () => {
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
      selectedWorkflowId: "video_ltx2_3_retake.json",
      availableWorkflows: [
        { id: "video_ltx2_3_retake.json", name: "LTX2.3 ReTake" },
        { id: "wf-switched.json", name: "Switched Workflow" },
      ],
      syncedWorkflow: {
        "1": {
          class_type: "OriginalWorkflow",
          inputs: {},
        },
      },
      activeWorkflowRules: queuedRules,
      rulesWorkflowSourceId: "video_ltx2_3_retake.json",
      editorRef: {} as HTMLIFrameElement,
    });

    const submitPromise = useGenerationStore.getState().submitGeneration({});
    await flushMicrotasks();

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);

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
      workflowId: "video_ltx2_3_retake.json",
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

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workflowId: "video_ltx2_3_retake.json",
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

    expect(mockPreResolvePrompt).toHaveBeenCalledTimes(1);
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

  it("tracks postprocessing jobs after completion and clears once postprocess finishes", async () => {
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

    expect(useGenerationStore.getState().postprocessingJobIds).toEqual([
      "prompt-post",
    ]);

    postprocessDeferred.resolve({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    await flushMicrotasks();

    const state = useGenerationStore.getState();
    expect(state.postprocessingJobIds).toEqual([]);
    expect(state.jobs.get("prompt-post")?.importedAssetIds).toEqual([
      "asset-1",
    ]);
  });

  it("passes an auto family hash into postprocess for generated outputs", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      wsClient: null,
      connectionStatus: "disconnected",
      syncedWorkflow: {
        "1": {
          class_type: "LoadImage",
          inputs: {
            image: "input.png",
          },
        },
        "2": {
          class_type: "ImageConsumer",
          inputs: {
            image: ["1", 0],
            seed: 123,
          },
        },
      },
    });

    useGenerationStore.getState().connect();
    await flushMicrotasks();
    const client = getLatestClient();

    const submitPromise = useGenerationStore.getState().submitGeneration({});
    const jobId = await submitPromise;
    expect(jobId).toBe("prompt-1");

    client.emitEvent({
      type: "executing",
      data: {
        node: null,
        prompt_id: "prompt-1",
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockFrontendPostprocess).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        autoFamilyRequestKey: expect.stringMatching(
          /^generation-family-request:v1:/,
        ),
      }),
    );
  });

  it("dispatches the next queued generation while the previous one is still postprocessing", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      wsClient: null,
      connectionStatus: "disconnected",
    });
    const postprocessDeferred = createDeferred<{
      postprocessedPreview: null;
      postprocessError: null;
      importedAssetIds: string[];
    }>();
    mockFrontendPostprocess.mockReturnValue(postprocessDeferred.promise);
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
      });

    useGenerationStore.getState().connect();
    await flushMicrotasks();
    const client = getLatestClient();

    await useGenerationStore.getState().queueGeneration({}, {}, {}, {}, 2);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);

    client.emitEvent({
      type: "executing",
      data: {
        node: null,
        prompt_id: "prompt-1",
      },
    });
    await flushMicrotasks();
    // Completion kicks off postprocess and the next queue dispatch on separate
    // async hops, so we wait for both state transitions before asserting.
    await flushMicrotasks();

    const stateWhileOverlapped = useGenerationStore.getState();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(stateWhileOverlapped.postprocessingJobIds).toEqual(["prompt-1"]);
    expect(stateWhileOverlapped.activeJobId).toBe("prompt-2");
    expect(stateWhileOverlapped.generationQueue).toHaveLength(0);

    postprocessDeferred.resolve({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    await flushMicrotasks();

    expect(useGenerationStore.getState().postprocessingJobIds).toEqual([]);
  });

  it("completes cached queued generations when ComfyUI emits execution_success without executing-null", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      wsClient: null,
      connectionStatus: "disconnected",
    });
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
      });
    mockGetHistoryOutputsWithRetry
      .mockResolvedValueOnce([
        {
          filename: "output.png",
          subfolder: "",
          type: "output",
          viewUrl: "/output.png",
        },
      ])
      .mockResolvedValueOnce([]);

    useGenerationStore.getState().connect();
    await flushMicrotasks();
    const client = getLatestClient();

    await useGenerationStore.getState().queueGeneration({}, {}, {}, {}, 2);
    expect(useGenerationStore.getState().activeJobId).toBe("prompt-1");

    client.emitEvent({
      type: "executing",
      data: {
        node: null,
        prompt_id: "prompt-1",
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(useGenerationStore.getState().activeJobId).toBe("prompt-2");

    client.emitEvent({
      type: "execution_cached",
      data: {
        prompt_id: "prompt-2",
        nodes: [],
      },
    });
    client.emitEvent({
      type: "execution_success",
      data: {
        prompt_id: "prompt-2",
        timestamp: Date.now(),
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const finalState = useGenerationStore.getState();
    expect(finalState.activeJobId).toBeNull();
    expect(finalState.generationQueue).toHaveLength(0);
    expect(finalState.jobs.get("prompt-2")?.status).toBe("completed");
    expect(finalState.jobs.get("prompt-2")?.outputs).toEqual([]);
  });

  it("finalizes a prompt only once when both executing-null and execution_success arrive", async () => {
    const historyDeferred = createDeferred<
      Array<{
        filename: string;
        subfolder: string;
        type: string;
        viewUrl: string;
      }>
    >();
    const postprocessDeferred = createDeferred<{
      postprocessedPreview: null;
      postprocessError: null;
      importedAssetIds: string[];
    }>();

    mockGetHistoryOutputsWithRetry.mockReturnValue(historyDeferred.promise);
    mockFrontendPostprocess.mockReturnValue(postprocessDeferred.promise);

    useGenerationStore.setState({
      jobs: new Map([["prompt-dual-finish", makeQueuedJob("prompt-dual-finish")]]),
      activeJobId: "prompt-dual-finish",
      pipelineRunToken: 1,
    });

    useGenerationStore.getState().connect();
    const client = getLatestClient();

    client.emitEvent({
      type: "executing",
      data: {
        node: null,
        prompt_id: "prompt-dual-finish",
      },
    });
    client.emitEvent({
      type: "execution_success",
      data: {
        prompt_id: "prompt-dual-finish",
        timestamp: Date.now(),
      },
    });
    await flushMicrotasks();

    expect(mockGetHistoryOutputsWithRetry).toHaveBeenCalledTimes(1);

    historyDeferred.resolve([
      {
        filename: "output.png",
        subfolder: "",
        type: "output",
        viewUrl: "/output.png",
      },
    ]);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockFrontendPostprocess).toHaveBeenCalledTimes(1);
    expect(useGenerationStore.getState().postprocessingJobIds).toEqual([
      "prompt-dual-finish",
    ]);

    postprocessDeferred.resolve({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    await flushMicrotasks();

    expect(
      useGenerationStore.getState().jobs.get("prompt-dual-finish")
        ?.importedAssetIds,
    ).toEqual(["asset-1"]);
  });

  it("reconciles an in-flight job from history after websocket reconnect", async () => {
    useGenerationStore.setState({
      jobs: new Map([["prompt-recover", makeQueuedJob("prompt-recover")]]),
      activeJobId: "prompt-recover",
      pipelineRunToken: 1,
    });
    mockGetPromptHistoryStateWithRetry.mockResolvedValueOnce({
      hasPromptEntry: true,
      outputs: [
        {
          filename: "recovered.png",
          subfolder: "",
          type: "output",
          viewUrl: "/recovered.png",
        },
      ],
    });
    mockGetHistoryOutputsWithRetry.mockResolvedValueOnce([
      {
        filename: "recovered.png",
        subfolder: "",
        type: "output",
        viewUrl: "/recovered.png",
      },
    ]);

    useGenerationStore.getState().connect();
    const client = getLatestClient();

    client.emitConnectionChange("connected");
    await flushMicrotasks();
    client.emitConnectionChange("disconnected");
    client.emitConnectionChange("connected");
    await flushMicrotasks();
    await flushMicrotasks();

    const state = useGenerationStore.getState();
    expect(state.activeJobId).toBeNull();
    expect(state.jobs.get("prompt-recover")?.status).toBe("completed");
    expect(state.jobs.get("prompt-recover")?.outputs).toEqual([
      {
        filename: "recovered.png",
        subfolder: "",
        type: "output",
        viewUrl: "/recovered.png",
      },
    ]);
  });

  it("marks unrecoverable in-flight jobs as error after websocket reconnect", async () => {
    useGenerationStore.setState({
      jobs: new Map([["prompt-missing", makeQueuedJob("prompt-missing")]]),
      activeJobId: "prompt-missing",
      pipelineRunToken: 1,
    });

    useGenerationStore.getState().connect();
    const client = getLatestClient();

    client.emitConnectionChange("connected");
    await flushMicrotasks();
    client.emitConnectionChange("disconnected");
    client.emitConnectionChange("connected");
    await flushMicrotasks();
    await flushMicrotasks();

    const state = useGenerationStore.getState();
    expect(state.activeJobId).toBeNull();
    expect(state.jobs.get("prompt-missing")?.status).toBe("error");
    expect(state.jobs.get("prompt-missing")?.error).toContain(
      "could not be recovered",
    );
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

  it("resumes the queue when ComfyUI emits execution_interrupted", async () => {
    makeReadyStoreState();
    useGenerationStore.setState({
      wsClient: null,
      connectionStatus: "disconnected",
    });
    mockGenerate
      .mockResolvedValueOnce({
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
      })
      .mockResolvedValueOnce({
        prompt_id: "prompt-2",
        number: 2,
        node_errors: {},
      });

    useGenerationStore.getState().connect();
    await flushMicrotasks();
    const client = getLatestClient();

    await useGenerationStore.getState().queueGeneration({}, {}, {}, {}, 2);
    expect(useGenerationStore.getState().activeJobId).toBe("prompt-1");
    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);

    client.emitEvent({
      type: "execution_interrupted",
      data: {
        prompt_id: "prompt-1",
        node_id: "node-1",
        node_type: "KSampler",
        executed: [],
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const finalState = useGenerationStore.getState();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(finalState.activeJobId).toBe("prompt-2");
    expect(finalState.generationQueue).toHaveLength(0);
    expect(finalState.jobs.get("prompt-1")).toMatchObject({
      status: "error",
      error: "Generation interrupted",
      currentNode: "node-1",
    });
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
    const client = getLatestClient();

    client.emitPreview({
      blob: new Blob(["frame-2"], { type: "image/jpeg" }),
      frameIndex: 2,
    });
    client.emitPreview({
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
    const client = getLatestClient();

    client.emitPreview({
      blob: new Blob(["vhs-frame"], { type: "image/png" }),
      frameIndex: 1,
      frameRate: 8,
      totalFrames: 4,
    });

    const animationState = useGenerationStore.getState();
    expect(animationState.previewAnimation?.frameUrls[1]).toBe("blob:vhs-frame-1");

    client.emitPreview({
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
            widgetModes: {},
            derivedWidgetInputs: {},
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
            widgetModes: {},
            derivedWidgetInputs: {},
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
        },
      ],
    });

    await useGenerationStore.getState().interruptCurrentGeneration();

    expect(useGenerationStore.getState().generationQueue).toHaveLength(1);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps the user cancellation message when ComfyUI emits a late execution error", async () => {
    const runningJob = {
      ...makeQueuedJob("prompt-running"),
      status: "running" as const,
    };
    const interruptDeferred = createDeferred<void>();
    mockInterrupt.mockReturnValueOnce(interruptDeferred.promise);

    useGenerationStore.setState({
      jobs: new Map([[runningJob.id, runningJob]]),
      activeJobId: runningJob.id,
      wsClient: null,
      connectionStatus: "disconnected",
    });
    useGenerationStore.getState().connect();
    const client = getLatestClient();

    const interruptPromise = useGenerationStore
      .getState()
      .interruptCurrentGeneration();
    await flushMicrotasks();

    client.emitEvent({
      type: "execution_error",
      data: {
        prompt_id: runningJob.id,
        node_id: "load-video",
        node_type: "LoadVideo",
        exception_message: "400: video is required",
        exception_type: "ValidationError",
        traceback: [],
      },
    });

    interruptDeferred.resolve();
    await interruptPromise;

    expect(useGenerationStore.getState().jobs.get(runningJob.id)).toMatchObject({
      status: "error",
      error: "Generation cancelled by user",
      currentNode: null,
    });
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
            widgetModes: {},
            derivedWidgetInputs: {},
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
