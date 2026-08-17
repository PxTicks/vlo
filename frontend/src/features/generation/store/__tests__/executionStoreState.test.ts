import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  interrupt: vi.fn(),
  deleteQueueItems: vi.fn(),
  createGenerationPlan: vi.fn(),
  prepareGenerationPlan: vi.fn(),
  buildSubmittedGeneration: vi.fn(),
  buildGenerationPreprocessCacheKey: vi.fn(),
  buildGenerationPreprocessCacheEntry: vi.fn(),
  mergeCachedPipelineOutputsIntoResponse: vi.fn(),
  updateGenerationPreprocessCacheFromResponse: vi.fn(),
  getSaveImageWebsocketNodeIds: vi.fn(),
  buildGenerationFamilyRequestKey: vi.fn(),
  mergeRuleWarnings: vi.fn(),
  createSubmissionErrorJob: vi.fn(),
  isActiveGenerationJob: vi.fn(),
  markJobError: vi.fn(),
  revokePreviewAnimation: vi.fn(),
  preResolvePrompt: vi.fn(),
  readActiveWorkflowFromIframe: vi.fn(),
  haveMatchingWorkflowNodes: vi.fn(),
  pruneRulesForSubmittedWorkflow: vi.fn(),
  getWorkflowPostprocessingConfig: vi.fn(),
  getMaskCropModeDefault: vi.fn(),
  evaluateRewrites: vi.fn(),
  evaluateEffectSwitchesForState: vi.fn(),
  evaluateWidgetDefaultOverrides: vi.fn(),
  projectState: {
    config: { aspectRatio: "16:9", fps: 30 },
    project: { id: "project-1" },
  },
}));

vi.mock("../../services/comfyuiApi", () => ({
  generate: mocks.generate,
  interrupt: mocks.interrupt,
  deleteQueueItems: mocks.deleteQueueItems,
}));

vi.mock("../../../project", () => ({
  useProjectStore: {
    getState: () => mocks.projectState,
  },
}));

vi.mock("../../pipeline/generationPlan", () => ({
  createGenerationPlan: mocks.createGenerationPlan,
  prepareGenerationPlan: mocks.prepareGenerationPlan,
  buildSubmittedGeneration: mocks.buildSubmittedGeneration,
  buildGenerationPreprocessCacheKey: mocks.buildGenerationPreprocessCacheKey,
  buildGenerationPreprocessCacheEntry: mocks.buildGenerationPreprocessCacheEntry,
  mergeCachedPipelineOutputsIntoResponse:
    mocks.mergeCachedPipelineOutputsIntoResponse,
  updateGenerationPreprocessCacheFromResponse:
    mocks.updateGenerationPreprocessCacheFromResponse,
  getSaveImageWebsocketNodeIds: mocks.getSaveImageWebsocketNodeIds,
}));

vi.mock("../../services/evaluateRewrites", () => ({
  evaluateEffectSwitchesForState: mocks.evaluateEffectSwitchesForState,
  evaluateRewrites: mocks.evaluateRewrites,
  evaluateWidgetDefaultOverrides: mocks.evaluateWidgetDefaultOverrides,
}));

vi.mock("../../services/iframeBridgeClient", () => ({
  iframeBridge: {
    resolvePrompt: mocks.preResolvePrompt,
    readActive: mocks.readActiveWorkflowFromIframe,
  },
}));

vi.mock("../../services/workflowFilenames", () => ({
  normalizeWorkflowFilename: vi.fn((value: string | null) => value),
}));

vi.mock("../../services/workflowRules", () => ({
  getMaskCropModeDefault: mocks.getMaskCropModeDefault,
  getWorkflowPostprocessingConfig: mocks.getWorkflowPostprocessingConfig,
  pruneRulesForSubmittedWorkflow: mocks.pruneRulesForSubmittedWorkflow,
}));

vi.mock("../../utils/workflowInputs", () => ({
  buildWorkflowInputId: vi.fn((nodeId: string, param: string) => `${nodeId}:${param}`),
  buildWorkflowInputLookup: vi.fn(() => new Map()),
  getNodeInputRequestKey: vi.fn((input: { id: string }) => input.id),
  getWorkflowInputId: vi.fn((input: { id: string }) => input.id),
}));

vi.mock("../../utils/workflowNodeSignature", () => ({
  haveMatchingWorkflowNodes: mocks.haveMatchingWorkflowNodes,
}));

vi.mock("../../pipeline/utils/abort", () => ({
  createGenerationAbortError: vi.fn((message: string) =>
    Object.assign(new Error(message), { name: "AbortError" }),
  ),
  isAbortError: vi.fn((error: unknown) =>
    error instanceof Error && error.name === "AbortError",
  ),
}));

vi.mock("../submission", () => ({
  createSubmissionErrorJob: mocks.createSubmissionErrorJob,
}));

vi.mock("../jobMutations", () => ({
  isActiveGenerationJob: mocks.isActiveGenerationJob,
  markJobError: mocks.markJobError,
}));

vi.mock("../../utils/familyAssignment", () => ({
  buildGenerationFamilyRequestKey: mocks.buildGenerationFamilyRequestKey,
}));

vi.mock("../previewState", () => ({
  revokePreviewAnimation: mocks.revokePreviewAnimation,
}));

vi.mock("../workflowCatalog", () => ({
  resolveWorkflowDisplayName: vi.fn(() => "Workflow"),
  isTemporaryWorkflowPersistenceId: vi.fn(() => false),
}));

vi.mock("../../utils/inputMetadata", () => ({
  buildWorkflowInputMetadataMap: vi.fn(() => ({})),
}));

vi.mock("../../services/warnings", () => ({
  mergeRuleWarnings: mocks.mergeRuleWarnings,
}));

import { useModelWorkStore } from "../../../modelWork";
import {
  WorkflowOutOfSyncError,
  buildExecutionStoreState,
} from "../executionStoreState";

interface Harness {
  state: Record<string, unknown>;
  set: ReturnType<typeof vi.fn>;
  get: () => Record<string, unknown>;
  actions: ReturnType<typeof buildExecutionStoreState>;
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    workflow: {
      workflowId: "workflow.json",
      workflowInputs: [],
      graphData: { nodes: [] },
      submittedWorkflow: { "1": { class_type: "SaveImage", inputs: {} } },
      promptIsPreResolved: true,
      workflowRules: null,
    },
    preprocess: {
      slotValues: {},
      derivedMaskMappings: [],
    },
    submission: {
      frontendStateWidgetValues: {},
      inputMetadata: {},
      bypassNodeIds: [],
    },
    metadata: {
      generationMetadata: {
        source: "generated",
        workflowName: "Workflow",
        inputs: [],
        replayState: { version: 1 },
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
    ...overrides,
  };
}

function createHarness(overrides: Record<string, unknown> = {}): Harness {
  let state: Record<string, unknown> = {
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    latestPreviewUrl: null,
    previewAnimation: null,
    wsClient: { currentClientId: "client-1" },
    runtimeStatus: { comfyui: { status: "connected", error: null } },
    runtimeStatusError: null,
    connectionStatus: "connected",
    isWorkflowLoading: false,
    isWorkflowReady: true,
    preResolvedPromptEnabled: true,
    editorRef: null,
    rulesWorkflowSourceId: null,
    selectedWorkflowId: "workflow.json",
    availableWorkflows: [],
    activeWorkflowRules: null,
    activeRulesWarnings: [],
    workflowInputs: [],
    syncedWorkflow: {},
    syncedGraphData: { nodes: [] },
    iframeWorkflowInstanceId: "workflow-instance",
    iframeWorkflowRevision: 0,
    mediaInputs: {},
    derivedMaskMappings: [],
    exactAspectRatio: false,
    targetResolution: 720,
    maskCropMode: "full",
    maskCropDilation: 0,
    workflowRuleWarnings: [],
    ...overrides,
  };
  const get = () => state;
  const set = vi.fn(
    (
      update:
        | Record<string, unknown>
        | ((current: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      const patch = typeof update === "function" ? update(state) : update;
      state = { ...state, ...patch };
    },
  );
  const actions = buildExecutionStoreState(set as never, get as never);
  state = { ...state, ...actions, ...overrides };
  return {
    get state() {
      return state;
    },
    set,
    get,
    actions,
  };
}

/** Put the shared ledger into a state where `local-gpu` is held by a tenant. */
function holdGpuWith(tenant: string | null): void {
  useModelWorkStore.setState({
    ready: true,
    revision: 1,
    entries: [],
    resources:
      tenant === null
        ? []
        : [
            {
              resource: "local-gpu",
              width: 1,
              tenant,
              occupancyId: "occ-1",
              holderCount: 1,
            },
          ],
  });
}

describe("buildExecutionStoreState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holdGpuWith(null);
    mocks.projectState.project = { id: "project-1" };
    const plan = makePlan();
    mocks.createGenerationPlan.mockReturnValue(plan);
    mocks.prepareGenerationPlan.mockResolvedValue({
      plan,
      request: {
        workflow: { fallback: true },
        textInputs: {},
        imageInputs: {},
        videoInputs: {},
        audioInputs: {},
        cachedMediaInputs: {},
      },
    });
    mocks.buildGenerationPreprocessCacheKey.mockReturnValue("cache-key");
    mocks.buildGenerationPreprocessCacheEntry.mockReturnValue({
      key: "cache-key",
    });
    mocks.mergeCachedPipelineOutputsIntoResponse.mockImplementation(
      (response) => response,
    );
    mocks.updateGenerationPreprocessCacheFromResponse.mockImplementation(
      (entry) => entry,
    );
    mocks.getSaveImageWebsocketNodeIds.mockReturnValue(new Set(["1"]));
    mocks.buildGenerationFamilyRequestKey.mockResolvedValue("family-key");
    mocks.generate.mockResolvedValue({ promptId: "server-response" });
    mocks.buildSubmittedGeneration.mockReturnValue({
      promptId: "prompt-1",
      deliveryId: "delivery-1",
      responseWarnings: ["warning"],
      appliedWidgetValues: { seed: 42 },
      aspectRatioProcessing: null,
      generationMetadata: makePlan().metadata.generationMetadata,
      usesSaveImageWebsocketOutputs: true,
      saveImageWebsocketNodeIds: ["1"],
      preparedMaskFile: null,
    });
    mocks.mergeRuleWarnings.mockReturnValue(["warning"]);
    mocks.preResolvePrompt.mockResolvedValue({
      output: { "1": { class_type: "SaveImage", inputs: {} } },
    });
    mocks.readActiveWorkflowFromIframe.mockReturnValue(null);
    mocks.haveMatchingWorkflowNodes.mockReturnValue(true);
    mocks.pruneRulesForSubmittedWorkflow.mockImplementation((rules) => rules);
    mocks.getWorkflowPostprocessingConfig.mockReturnValue(null);
    mocks.getMaskCropModeDefault.mockReturnValue("full");
    mocks.evaluateRewrites.mockReturnValue({ bypass: [], widgetOverrides: [] });
    mocks.evaluateEffectSwitchesForState.mockReturnValue({
      bypass: [],
      widgetOverrides: [],
    });
    mocks.evaluateWidgetDefaultOverrides.mockReturnValue([]);
    mocks.createSubmissionErrorJob.mockImplementation((error: unknown) => ({
      id: "error-job",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }));
    mocks.isActiveGenerationJob.mockImplementation(
      (job: { status?: string } | null) =>
        job?.status === "queued" || job?.status === "running",
    );
    mocks.markJobError.mockImplementation(
      (
        state: Record<string, unknown>,
        id: string,
        message: string,
        _node: unknown,
        options: { clearActiveJob?: boolean } = {},
      ) => {
        const jobs = new Map(
          state.jobs as Map<string, Record<string, unknown>>,
        );
        jobs.set(id, { ...jobs.get(id), status: "error", error: message });
        return {
          jobs,
          ...(options.clearActiveJob ? { activeJobId: null } : {}),
        };
      },
    );
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it("submits a prepared generation and creates its delivery job", async () => {
    const harness = createHarness({
      latestPreviewUrl: "blob:old",
      previewAnimation: { urls: ["blob:frame"] },
    });

    await expect(harness.actions.submitGeneration({})).resolves.toBe("prompt-1");

    expect(mocks.prepareGenerationPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1" }),
      expect.objectContaining({
        clientId: "client-1",
        signal: expect.any(AbortSignal),
        cacheEntry: null,
      }),
    );
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        workflow: expect.objectContaining({ "1": expect.any(Object) }),
        promptIsPreResolved: true,
        deliveryContext: expect.objectContaining({
          planId: "plan-1",
          autoFamilyRequestKey: "family-key",
          usesSaveImageWebsocketOutputs: true,
          saveImageWebsocketNodeIds: ["1"],
        }),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:old");
    expect(mocks.revokePreviewAnimation).toHaveBeenCalled();
    expect(harness.state).toMatchObject({
      activeJobId: "prompt-1",
      latestPreviewUrl: null,
      previewAnimation: null,
      pipelineStatus: {
        phase: "idle",
      },
      lastAppliedWidgetValues: { seed: 42 },
    });
    const jobs = harness.state.jobs as Map<string, { status: string }>;
    expect(jobs.get("prompt-1")?.status).toBe("queued");
    expect(
      (harness.state.jobPreviewFrames as Map<string, unknown[]>).get("prompt-1"),
    ).toEqual([]);
  });

  it("captures graphToPrompt output when a submitted workflow is absent", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
        workflowRules: { version: 1 },
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    mocks.prepareGenerationPlan.mockResolvedValue({
      plan,
      request: {
        workflow: { fallback: true },
        textInputs: {},
        imageInputs: {},
        videoInputs: {},
        audioInputs: {},
        cachedMediaInputs: {},
      },
    });
    mocks.readActiveWorkflowFromIframe.mockReturnValue({
      filename: "workflow.json",
      graphData: { nodes: [] },
    });
    const harness = createHarness({
      editorRef: {} as HTMLIFrameElement,
      activeWorkflowRules: { version: 1 },
    });

    await expect(harness.actions.submitGeneration({})).resolves.toBe("prompt-1");

    expect(mocks.preResolvePrompt).toHaveBeenCalledWith(
      { workflowInstanceId: "workflow-instance", revision: 0 },
      [],
      [],
    );
    expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
      promptIsPreResolved: true,
    });
    expect(mocks.pruneRulesForSubmittedWorkflow).toHaveBeenCalled();
  });

  it("surfaces missing editor, failed graph capture, and workflow drift", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    mocks.prepareGenerationPlan.mockResolvedValue({
      plan,
      request: {
        workflow: {},
        textInputs: {},
        imageInputs: {},
        videoInputs: {},
        audioInputs: {},
      },
    });

    const missingEditor = createHarness();
    await expect(missingEditor.actions.submitGeneration({})).resolves.toBe(
      "error-job",
    );

    const captureFailed = createHarness({
      editorRef: {} as HTMLIFrameElement,
    });
    mocks.preResolvePrompt.mockResolvedValueOnce(null);
    await expect(captureFailed.actions.submitGeneration({})).resolves.toBe(
      "error-job",
    );

    const drifted = createHarness({
      editorRef: {} as HTMLIFrameElement,
      syncedGraphData: null,
      iframeWorkflowInstanceId: null,
      iframeWorkflowRevision: null,
    });
    await expect(drifted.actions.submitGeneration({})).resolves.toBe(
      "error-job",
    );
    expect(
      (drifted.state.jobs as Map<string, { error: string }>).get("error-job")
        ?.error,
    ).toMatch(/unknown workflow/);
  });

  it("exposes workflow mismatch details", () => {
    const error = new WorkflowOutOfSyncError(null, null);
    expect(error.name).toBe("WorkflowOutOfSyncError");
    expect(error.expectedWorkflowId).toBeNull();
    expect(error.iframeFilename).toBeNull();
    expect(error.message).toContain("an unknown workflow");
  });

  it("waits for and applies prepared timeline-selection files", async () => {
    const preparedVideoFile = new File(["video"], "prepared.mp4", {
      type: "video/mp4",
    });
    const preparedMaskFile = new File(["mask"], "mask.webm", {
      type: "video/webm",
    });
    const plan = makePlan({
      preprocess: {
        slotValues: {
          selection: {
            type: "video_selection",
            pendingExtractionRequestId: 4,
          },
        },
        derivedMaskMappings: [],
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    const harness = createHarness({
      mediaInputs: {
        selection: {
          kind: "timelineSelection",
          mediaType: "video",
          extractionRequestId: 4,
          isExtracting: false,
          preparedVideoFile,
          preparedMaskFile,
        },
      },
    });

    await harness.actions.submitGeneration({});

    const selectionSlot = (
      plan as unknown as {
        preprocess: {
          slotValues: Record<string, Record<string, unknown>>;
        };
      }
    ).preprocess.slotValues.selection;
    expect(selectionSlot).toMatchObject({
      pendingExtractionRequestId: undefined,
      preparedVideoFile,
      preparedMaskFile,
    });
  });

  it("stops waiting when extraction state is cleared, replaced, or superseded", async () => {
    for (const mediaInput of [
      undefined,
      { kind: "asset", mediaType: "video" },
      {
        kind: "timelineSelection",
        mediaType: "image",
        extractionRequestId: 1,
      },
      {
        kind: "timelineSelection",
        mediaType: "video",
        extractionRequestId: 99,
      },
    ]) {
      const plan = makePlan({
        preprocess: {
          slotValues: {
            selection: {
              type: "video_selection",
              pendingExtractionRequestId: 4,
            },
          },
          derivedMaskMappings: [],
        },
      });
      mocks.createGenerationPlan.mockReturnValueOnce(plan);
      const harness = createHarness({
        mediaInputs: mediaInput ? { selection: mediaInput } : {},
      });
      await expect(harness.actions.submitGeneration({})).resolves.toBe(
        "prompt-1",
      );
    }
  });

  it("treats preprocessing aborts as cancellation instead of submission errors", async () => {
    mocks.prepareGenerationPlan.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
    );
    const harness = createHarness();
    await expect(harness.actions.submitGeneration({})).resolves.toBeNull();
    expect(mocks.createSubmissionErrorJob).not.toHaveBeenCalled();
    expect(harness.state.preprocessAbortController).toBeNull();
  });

  it("drops preview-frame staging when websocket frames are not used", async () => {
    mocks.buildSubmittedGeneration.mockReturnValueOnce({
      promptId: "prompt-1",
      deliveryId: "delivery-1",
      responseWarnings: [],
      appliedWidgetValues: {},
      aspectRatioProcessing: null,
      generationMetadata: makePlan().metadata.generationMetadata,
      usesSaveImageWebsocketOutputs: false,
      saveImageWebsocketNodeIds: [],
      preparedMaskFile: null,
    });
    const harness = createHarness({
      jobPreviewFrames: new Map([["prompt-1", ["old"]]]),
    });
    await harness.actions.submitGeneration({});
    expect(
      (harness.state.jobPreviewFrames as Map<string, unknown>).has("prompt-1"),
    ).toBe(false);
  });

  it("uses cached preprocessing on a matching second submission", async () => {
    const harness = createHarness();
    await harness.actions.submitGeneration({});
    (harness.state.jobs as Map<string, { status: string }>).get(
      "prompt-1",
    )!.status = "complete";
    (
      harness.set as unknown as (update: Record<string, unknown>) => void
    )({ activeJobId: null });
    mocks.buildSubmittedGeneration.mockReturnValueOnce({
      ...mocks.buildSubmittedGeneration.mock.results[0]?.value,
      promptId: "prompt-2",
      deliveryId: "delivery-2",
    });

    await harness.actions.submitGeneration({});

    expect(mocks.prepareGenerationPlan).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ cacheEntry: { key: "cache-key" } }),
    );
    expect(mocks.mergeCachedPipelineOutputsIntoResponse).toHaveBeenCalled();
    expect(mocks.updateGenerationPreprocessCacheFromResponse).toHaveBeenCalled();
  });

  it.each([
    [
      { wsClient: null },
      "Not connected to ComfyUI",
    ],
    [
      {
        runtimeStatus: { comfyui: { status: "error", error: "runtime down" } },
        connectionStatus: "error",
      },
      "runtime down",
    ],
  ])("rolls submission boundary failures into an error job", async (state, message) => {
    const harness = createHarness(state);
    await expect(harness.actions.submitGeneration({})).resolves.toBe("error-job");
    expect(harness.state.activeJobId).toBe("error-job");
    expect(
      (harness.state.jobs as Map<string, { error: string }>).get("error-job")
        ?.error,
    ).toBe(message);
  });

  it("reports missing projects and family-key failures without losing submission", async () => {
    mocks.projectState.project = null as unknown as { id: string };
    const missingProject = createHarness();
    await expect(missingProject.actions.submitGeneration({})).resolves.toBe(
      "error-job",
    );
    expect(mocks.generate).not.toHaveBeenCalled();

    mocks.projectState.project = { id: "project-1" };
    mocks.buildGenerationFamilyRequestKey.mockRejectedValue(new Error("hash failed"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    await expect(harness.actions.submitGeneration({})).resolves.toBe("prompt-1");
    expect(
      mocks.generate.mock.calls.at(-1)?.[0].deliveryContext.autoFamilyRequestKey,
    ).toBeNull();
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("rejects busy or loading submissions before dispatch", async () => {
    const busy = createHarness({
      generationQueue: [makePlan()],
    });
    await expect(busy.actions.submitGeneration({})).resolves.toBeNull();
    expect(mocks.createGenerationPlan).not.toHaveBeenCalled();

    const loading = createHarness({
      isWorkflowLoading: true,
      isWorkflowReady: false,
    });
    await expect(loading.actions.submitGeneration({})).resolves.toBe("error-job");
    expect(loading.state.activeJobId).toBe("error-job");
  });

  it("queues a safe integer count while disconnected and clears it", async () => {
    const harness = createHarness({
      wsClient: null,
      runtimeStatus: { comfyui: { status: "error" } },
      connectionStatus: "error",
    });
    await harness.actions.queueGeneration({}, {}, {}, {}, 2.9);
    expect(mocks.createGenerationPlan).toHaveBeenCalledTimes(2);
    expect(harness.state.generationQueue).toHaveLength(2);
    harness.actions.clearGenerationQueue();
    expect(harness.state.generationQueue).toEqual([]);
  });

  it("holds queued plans while vlo's own models own the GPU, without spinning", async () => {
    // Regression: the GPU gate returns without dequeuing anything, and the
    // `finally` block re-invokes the queue. With no `await` on that path the
    // re-invocation recursed synchronously until the stack blew.
    holdGpuWith("backend-process");
    const harness = createHarness();

    await harness.actions.queueGeneration({}, {}, {}, {}, 2);

    expect(harness.state.generationQueue).toHaveLength(2);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("requeues once on a 409 instead of resubmitting until the ledger catches up", async () => {
    const harness = createHarness();
    // The backend refuses admission, but the ledger has not caught up yet — so
    // the gate alone would let the queue resubmit immediately and forever.
    mocks.generate.mockRejectedValue({
      status: 409,
      payload: { error: { code: "gpu_busy" } },
    });

    await harness.actions.queueGeneration({}, {}, {}, {}, 2);

    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(harness.state.generationQueue).toHaveLength(2);
    expect((harness.state.pipelineStatus as { message: string }).message).toBe(
      "Waiting for the GPU",
    );
    expect(mocks.createSubmissionErrorJob).not.toHaveBeenCalled();
  });

  it("keeps the enqueue-time capture when preprocessing leaves the effects unchanged", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
        workflowRules: { version: 1 },
      },
      submission: {
        frontendStateWidgetValues: {},
        inputMetadata: {},
        bypassNodeIds: ["9"],
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    // Keyed on the rules argument: the queued plan carries its own detached
    // rules, so a later edit to the live rules must not reach it.
    mocks.evaluateRewrites.mockImplementation((rules: unknown) =>
      (rules as { version?: number } | null)?.version === 99
        ? { bypass: ["999"], widgetOverrides: [] }
        : {
            bypass: ["7"],
            widgetOverrides: [{ node_id: "5", widget: "seed", value: 1 }],
          },
    );
    // Keep the plan queued so live state can change before dispatch.
    holdGpuWith("backend-process");
    const harness = createHarness({ editorRef: {} as HTMLIFrameElement });

    await harness.actions.queueGeneration({});

    expect(mocks.preResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mocks.preResolvePrompt).toHaveBeenCalledWith(
      { workflowInstanceId: "workflow-instance", revision: 0 },
      ["7", "9"],
      [{ node_id: "5", widget: "seed", value: 1 }],
    );
    const queue = harness.state.generationQueue as Array<{
      effects: Record<string, unknown>;
      workflow: { submittedWorkflow: unknown };
    }>;
    expect(queue[0].effects).toMatchObject({
      schemaVersion: 1,
      expectation: { workflowInstanceId: "workflow-instance", revision: 0 },
    });
    expect(queue[0].workflow.submittedWorkflow).toEqual({
      "1": { class_type: "SaveImage", inputs: {} },
    });

    // Later rule changes, a workflow switch, and editor disposal must not
    // alter the already queued item: nothing is resolved a second time and
    // the frozen capture is what reaches the backend.
    (
      harness.set as unknown as (update: Record<string, unknown>) => void
    )({
      iframeWorkflowInstanceId: "different-instance",
      iframeWorkflowRevision: 42,
      activeWorkflowRules: { version: 99 },
      editorRef: null,
    });
    holdGpuWith(null);
    await harness.actions.processGenerationQueue();

    expect(mocks.preResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
      promptIsPreResolved: true,
    });
  });

  it("re-resolves against the pinned expectation when preprocessing derives a new input", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    // The queued slot values have no mask; preprocessing renders one, so the
    // `all_missing` bypass that held at enqueue no longer applies.
    mocks.evaluateRewrites.mockImplementation(
      (_rules: unknown, providedInputIds: ReadonlySet<string>) =>
        providedInputIds.has("689")
          ? { bypass: [], widgetOverrides: [] }
          : { bypass: ["689"], widgetOverrides: [] },
    );
    mocks.prepareGenerationPlan.mockResolvedValue({
      plan,
      request: {
        workflow: { fallback: true },
        textInputs: {},
        imageInputs: {},
        videoInputs: { "689": new File(["mask"], "mask.mp4") },
        audioInputs: {},
        cachedMediaInputs: {},
      },
    });
    mocks.preResolvePrompt.mockResolvedValueOnce({
      output: { "1": { class_type: "StaleCapture", inputs: {} } },
    });
    holdGpuWith("backend-process");
    const harness = createHarness({ editorRef: {} as HTMLIFrameElement });

    await harness.actions.queueGeneration({});
    expect(mocks.preResolvePrompt).toHaveBeenCalledTimes(1);
    expect(mocks.preResolvePrompt.mock.calls[0]?.[1]).toEqual(["689"]);

    // The live identity moved on; the queued item must still resolve against
    // the workflow it was enqueued against, not the one loaded now.
    (
      harness.set as unknown as (update: Record<string, unknown>) => void
    )({
      iframeWorkflowInstanceId: "different-instance",
      iframeWorkflowRevision: 42,
    });
    holdGpuWith(null);
    await harness.actions.processGenerationQueue();

    expect(mocks.preResolvePrompt).toHaveBeenCalledTimes(2);
    expect(mocks.preResolvePrompt).toHaveBeenLastCalledWith(
      { workflowInstanceId: "workflow-instance", revision: 0 },
      [],
      [],
    );
    expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
      promptIsPreResolved: true,
    });
  });

  it("fails the dispatch when a stale queued capture cannot be resolved again", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    mocks.evaluateRewrites.mockImplementation(
      (_rules: unknown, providedInputIds: ReadonlySet<string>) =>
        providedInputIds.has("689")
          ? { bypass: [], widgetOverrides: [] }
          : { bypass: ["689"], widgetOverrides: [] },
    );
    mocks.prepareGenerationPlan.mockResolvedValue({
      plan,
      request: {
        workflow: { fallback: true },
        textInputs: {},
        imageInputs: {},
        videoInputs: { "689": new File(["mask"], "mask.mp4") },
        audioInputs: {},
        cachedMediaInputs: {},
      },
    });
    holdGpuWith("backend-process");
    const harness = createHarness({ editorRef: {} as HTMLIFrameElement });

    await harness.actions.queueGeneration({});

    // The user edited the graph in the meantime: the bridge rejects the
    // pinned expectation, and nothing is submitted with the stale capture.
    mocks.preResolvePrompt.mockRejectedValueOnce(
      new Error("The workflow in the editor changed"),
    );
    holdGpuWith(null);
    await harness.actions.processGenerationQueue();

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(harness.state.activeJobId).toBe("error-job");
  });

  it("falls back to the live workflow identity when the editor was closed at enqueue", async () => {
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    holdGpuWith("backend-process");
    // Unmounting the editor clears its bridge identity too
    // (`unregisterEditor`), so there is nothing to pin.
    const harness = createHarness({
      editorRef: null,
      iframeWorkflowInstanceId: null,
      iframeWorkflowRevision: null,
    });

    await harness.actions.queueGeneration({});
    expect(mocks.preResolvePrompt).not.toHaveBeenCalled();
    const queue = harness.state.generationQueue as Array<{
      effects: { expectation: unknown };
    }>;
    expect(queue[0].effects.expectation).toBeNull();

    // The editor comes back: the queued item resolves against the identity it
    // now reports, exactly as an immediate submission would.
    (
      harness.set as unknown as (update: Record<string, unknown>) => void
    )({
      editorRef: {} as HTMLIFrameElement,
      iframeWorkflowInstanceId: "new-instance",
      iframeWorkflowRevision: 9,
    });
    holdGpuWith(null);
    await harness.actions.processGenerationQueue();

    expect(mocks.preResolvePrompt).toHaveBeenCalledWith(
      { workflowInstanceId: "new-instance", revision: 9 },
      [],
      [],
    );
    expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
      workflow: { "1": { class_type: "SaveImage", inputs: {} } },
      promptIsPreResolved: true,
    });
  });

  it("rejects invalid queued effect targets at enqueue, before any submission work", async () => {
    const plan = makePlan({
      workflow: { ...makePlan().workflow, submittedWorkflow: null },
      submission: {
        frontendStateWidgetValues: {},
        inputMetadata: {},
        bypassNodeIds: ["  "],
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    const harness = createHarness({ editorRef: {} as HTMLIFrameElement });

    await harness.actions.queueGeneration({});

    expect(harness.state.activeJobId).toBe("error-job");
    expect(harness.state.generationQueue).toEqual([]);
    expect(mocks.preResolvePrompt).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(
      (harness.state.jobs as Map<string, { error: string }>).get("error-job")
        ?.error,
    ).toMatch(/not a valid node id/);
  });

  it("normalizes colliding widget writes into a last-write-wins payload with a diagnostic", async () => {
    mocks.evaluateWidgetDefaultOverrides.mockReturnValue([
      { node_id: "5", widget: "seed", value: 1 },
    ]);
    mocks.evaluateRewrites.mockReturnValue({
      bypass: [],
      widgetOverrides: [{ node_id: "5", widget: "seed", value: 2 }],
    });
    const plan = makePlan({
      workflow: {
        ...makePlan().workflow,
        submittedWorkflow: null,
        promptIsPreResolved: false,
      },
    });
    mocks.createGenerationPlan.mockReturnValue(plan);
    holdGpuWith("backend-process");
    const harness = createHarness({ editorRef: {} as HTMLIFrameElement });

    await harness.actions.queueGeneration({});

    expect(mocks.preResolvePrompt).toHaveBeenCalledWith(
      { workflowInstanceId: "workflow-instance", revision: 0 },
      [],
      [{ node_id: "5", widget: "seed", value: 2 }],
    );
    const queue = harness.state.generationQueue as Array<{
      effects: { diagnostics: unknown[] };
    }>;
    expect(queue[0].effects.diagnostics).toEqual([
      expect.objectContaining({
        code: "widget-collision",
        severity: "warning",
      }),
    ]);
  });

  it("creates an error job when queue capture fails or workflow is loading", async () => {
    const loading = createHarness({
      isWorkflowLoading: true,
      isWorkflowReady: false,
    });
    await loading.actions.queueGeneration({});
    expect(loading.state.activeJobId).toBe("error-job");

    mocks.createGenerationPlan.mockImplementation(() => {
      throw new Error("bad plan");
    });
    const failed = createHarness();
    await failed.actions.queueGeneration({});
    expect(failed.state.activeJobId).toBe("error-job");
  });

  it("interrupts preprocessing, optionally preserving queued work", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      pipelineStatus: {
        phase: "preprocessing",
        message: "Preparing",
        interruptible: true,
      },
      pipelineRunToken: 4,
      preprocessAbortController: controller,
      generationQueue: [makePlan()],
      wsClient: null,
    });

    await harness.actions.interruptCurrentGeneration();
    expect(controller.signal.aborted).toBe(true);
    expect(harness.state.pipelineRunToken).toBe(5);
    expect(harness.state.generationQueue).toHaveLength(1);

    const second = new AbortController();
    (
      harness.set as unknown as (update: Record<string, unknown>) => void
    )({
      pipelineStatus: {
        phase: "preprocessing",
        message: "Preparing",
        interruptible: true,
      },
      preprocessAbortController: second,
      generationQueue: [makePlan()],
    });
    await harness.actions.cancelGeneration();
    expect(second.signal.aborted).toBe(true);
    expect(harness.state.generationQueue).toEqual([]);
  });

  it("marks active jobs cancelled and reports interrupt failures", async () => {
    const jobs = new Map([
      ["job-1", { id: "job-1", status: "running", error: null }],
    ]);
    const harness = createHarness({ jobs, activeJobId: "job-1" });
    await harness.actions.cancelGeneration();
    // Cancel must be scoped to our own prompt id so it can't touch the iframe's
    // jobs on the shared global queue.
    expect(mocks.deleteQueueItems).toHaveBeenCalledWith(["job-1"]);
    expect(mocks.interrupt).toHaveBeenCalledTimes(1);
    expect(mocks.interrupt).toHaveBeenCalledWith("job-1");
    expect(harness.state.activeJobId).toBeNull();

    const failedJobs = new Map([
      ["job-2", { id: "job-2", status: "queued", error: null }],
    ]);
    const failed = createHarness({ jobs: failedJobs, activeJobId: "job-2" });
    mocks.interrupt.mockRejectedValueOnce(new Error("offline"));
    await failed.actions.interruptCurrentGeneration();
    expect(mocks.markJobError).toHaveBeenLastCalledWith(
      expect.any(Object),
      "job-2",
      "Cancel failed: offline",
      null,
      expect.objectContaining({ nextConnectionStatus: "error" }),
    );
  });

  it("does nothing destructive when no active job exists", async () => {
    const harness = createHarness({
      jobs: new Map([["done", { id: "done", status: "complete" }]]),
      activeJobId: "done",
      generationQueue: [],
    });
    await harness.actions.interruptCurrentGeneration();
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });
});
