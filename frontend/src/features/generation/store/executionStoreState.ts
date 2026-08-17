import * as comfyApi from "../services/comfyuiApi";
import { useProjectStore } from "../../project";
import {
  selectIsLocalModelWorkHoldingGpu,
  useModelWorkStore,
} from "../../modelWork";
import { mergeRuleWarnings } from "../services/warnings";
import {
  buildSubmittedGeneration,
  buildGenerationPreprocessCacheEntry,
  buildGenerationPreprocessCacheKey,
  createGenerationPlan,
  getSaveImageWebsocketNodeIds,
  mergeCachedPipelineOutputsIntoResponse,
  prepareGenerationPlan,
  updateGenerationPreprocessCacheFromResponse,
  type GenerationPreprocessCacheEntry,
} from "../pipeline/generationPlan";
import type {
  GenerationCapturedEffects,
  GenerationDeliveryContext,
  GenerationPlan,
  GenerationRequest,
  GenerationWorkflowExpectation,
  SlotValue,
} from "../pipeline/types";
import {
  bridgeEffectPayloadsMatch,
  buildBridgeEffectPayload,
  captureGenerationEffectsForPlan,
  collectGenerationEffectErrors,
} from "../pipeline/generationGraphEffects";
import { iframeBridge } from "../services/iframeBridgeClient";
import {
  getMaskCropModeDefault,
  getWorkflowPostprocessingConfig,
  pruneRulesForSubmittedWorkflow,
} from "../services/workflowRules";
import {
  buildWorkflowInputId,
  buildWorkflowInputLookup,
  getWorkflowInputId,
  matchesNodeInputRequestKey,
  resolveWorkflowInputForSlot,
} from "../utils/workflowInputs";
import {
  createGenerationAbortError,
  isAbortError,
} from "../pipeline/utils/abort";
import type { WorkflowInput, WorkflowPostprocessingConfig } from "../types";
import { createSubmissionErrorJob } from "./submission";
import {
  GENERATION_CANCELLED_BY_USER_MESSAGE,
  IDLE_PIPELINE_STATUS,
  TEMP_WORKFLOW_ID,
} from "./constants";
import {
  isActiveGenerationJob,
  markJobError,
} from "./jobMutations";
import { buildGenerationFamilyRequestKey } from "../utils/familyAssignment";
import { revokePreviewAnimation } from "./previewState";
import { resolveWorkflowDisplayName } from "./workflowCatalog";
import { isTemporaryWorkflowPersistenceId } from "./workflowCatalog";
import { buildWorkflowInputMetadataMap } from "../utils/inputMetadata";
import type {
  GenerationExecutionState,
  GenerationStoreGet,
  GenerationStoreSet,
} from "./types";

function resolvePostprocessConfig(
  postprocessing:
    | import("../services/workflowRules").WorkflowPostprocessingConfig
    | null
    | undefined,
): WorkflowPostprocessingConfig {
  const fallback: WorkflowPostprocessingConfig = {
    mode: "auto",
    panel_preview: "raw_outputs",
    on_failure: "fallback_raw",
  };
  return {
    mode: postprocessing?.mode ?? fallback.mode,
    panel_preview: postprocessing?.panel_preview ?? fallback.panel_preview,
    on_failure: postprocessing?.on_failure ?? fallback.on_failure,
    ...(postprocessing?.stitch_fps != null
      ? { stitch_fps: postprocessing.stitch_fps }
      : {}),
    ...(postprocessing?.attach_generation_mask === false
      ? { attach_generation_mask: false }
      : {}),
  };
}

function clonePostprocessConfig(
  config: WorkflowPostprocessingConfig,
): WorkflowPostprocessingConfig {
  return {
    mode: config.mode,
    panel_preview: config.panel_preview,
    on_failure: config.on_failure,
    ...(config.stitch_fps != null ? { stitch_fps: config.stitch_fps } : {}),
    ...(config.attach_generation_mask === false
      ? { attach_generation_mask: false }
      : {}),
  };
}

function collectProvidedInputIds(
  plan: GenerationPlan,
  request?: GenerationRequest,
): Set<string> {
  if (request) {
    const ids = new Set<string>();
    const requestInputKeys = new Set<string>([
      ...Object.keys(request.textInputs),
      ...Object.keys(request.imageInputs),
      ...Object.keys(request.videoInputs),
      ...Object.keys(request.audioInputs),
    ]);
    for (const key of requestInputKeys) {
      ids.add(key);
    }

    const workflowInputById = buildWorkflowInputLookup(plan.workflow.workflowInputs);
    for (const input of plan.workflow.workflowInputs) {
      const hasRequestInput = [...requestInputKeys].some((requestKey) =>
        matchesNodeInputRequestKey(requestKey, input, workflowInputById),
      );
      if (!hasRequestInput) {
        continue;
      }
      ids.add(getWorkflowInputId(input));
      ids.add(input.nodeId);
    }

    // Cached reruns submit backend loader ids instead of fresh file uploads.
    // These still count as present for rewrite/default evaluation, otherwise
    // Prompt resolution can wrongly bypass the very nodes that need reinjection.
    for (const [nodeId, values] of Object.entries(request.cachedMediaInputs ?? {})) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        continue;
      }

      let nodeWasProvided = false;
      for (const [param, value] of Object.entries(values)) {
        if (
          value == null ||
          (typeof value === "string" && value.trim().length === 0)
        ) {
          continue;
        }

        ids.add(buildWorkflowInputId(nodeId, param));
        ids.add(`${nodeId}_${param}`);

        const matchedInput =
          workflowInputById.get(buildWorkflowInputId(nodeId, param)) ??
          workflowInputById.get(nodeId);
        if (matchedInput?.param === param) {
          ids.add(getWorkflowInputId(matchedInput));
        }

        nodeWasProvided = true;
      }

      if (nodeWasProvided) {
        ids.add(nodeId);
      }
    }

    const knownNodeIds = new Set<string>([
      ...plan.workflow.workflowInputs.map((input) => input.nodeId),
      ...plan.preprocess.derivedMaskMappings.flatMap((mapping) => [
        mapping.sourceNodeId,
        mapping.maskNodeId,
      ]),
    ]);
    const requestInputKeyList = [...requestInputKeys];
    for (const nodeId of knownNodeIds) {
      if (
        requestInputKeys.has(nodeId) ||
        requestInputKeyList.some((key) => key.startsWith(`${nodeId}_`))
      ) {
        ids.add(nodeId);
      }
    }
    return ids;
  }

  return collectProvidedInputIdsFromSlotValues(
    plan.workflow.workflowInputs,
    plan.preprocess.slotValues,
  );
}

function collectProvidedInputIdsFromSlotValues(
  workflowInputs: readonly WorkflowInput[],
  slotValues: Record<string, SlotValue>,
): Set<string> {
  const ids = new Set<string>();
  const workflowInputById = buildWorkflowInputLookup(workflowInputs);
  for (const [id, value] of Object.entries(slotValues)) {
    if (value.type === "text") {
      if (typeof value.value === "string" && value.value.trim().length > 0) {
        ids.add(id);
      }
    } else {
      ids.add(id);
    }
  }
  for (const input of workflowInputs) {
    const nodeId = input.nodeId;
    if (!nodeId) continue;
    const primaryId = input.id ?? `${nodeId}:${input.param}`;
    const hasInputSlot = [...ids].some((inputId) =>
      resolveWorkflowInputForSlot(inputId, workflowInputById) === input,
    );
    if (ids.has(primaryId) || hasInputSlot) {
      ids.add(nodeId);
      ids.add(primaryId);
    }
  }
  return ids;
}

function isComfyReadyForDispatch(
  state: ReturnType<GenerationStoreGet>,
): boolean {
  return (
    state.runtimeStatus?.comfyui.status === "connected" ||
    state.connectionStatus === "connected"
  );
}

/**
 * Advisory only. The authoritative reservation is taken in the backend before
 * the prompt is forwarded (a check-then-submit gap here could never exclude
 * anything); this just keeps the queue from firing requests it knows will come
 * back 409.
 */
function isLocalModelWorkHoldingGpu(): boolean {
  return selectIsLocalModelWorkHoldingGpu(useModelWorkStore.getState());
}

/** Fallback resume interval when no ledger event arrives to lift a GPU hold. */
const GPU_ADMISSION_HOLD_RETRY_MS = 2000;

function isGpuBusyRejection(error: unknown): boolean {
  // Duck-typed rather than `instanceof ComfyApiError`: the shape is what
  // matters, and this stays true through module mocking and bundle splitting.
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { status, payload } = error as {
    status?: unknown;
    payload?: { error?: { code?: unknown } };
  };
  return status === 409 && payload?.error?.code === "gpu_busy";
}

interface PendingExtractionEntry {
  inputId: string;
  expectedRequestId: number;
}

function collectPendingExtractions(
  plan: GenerationPlan,
): PendingExtractionEntry[] {
  const pending: PendingExtractionEntry[] = [];
  for (const [inputId, value] of Object.entries(plan.preprocess.slotValues)) {
    if (
      value.type === "video_selection" &&
      typeof value.pendingExtractionRequestId === "number"
    ) {
      pending.push({
        inputId,
        expectedRequestId: value.pendingExtractionRequestId,
      });
    }
  }
  return pending;
}

function isExtractionResolved(
  state: ReturnType<GenerationStoreGet>,
  entry: PendingExtractionEntry,
): boolean {
  const value = state.mediaInputs[entry.inputId];
  // Input cleared, replaced by an asset/frame, or wrong media kind: stop
  // waiting. The slot keeps its captured selection and `collectVideoInputs`
  // will fall back to a render-on-submit if `preparedVideoFile` stays unset.
  if (!value || value.kind !== "timelineSelection") return true;
  if (value.mediaType !== "video") return true;
  // Selection was superseded (a fresher extraction is now active or has
  // completed). Same fallback applies.
  if (value.extractionRequestId !== entry.expectedRequestId) return true;
  return !value.isExtracting;
}

async function waitForPendingExtractions(
  get: GenerationStoreGet,
  pending: PendingExtractionEntry[],
  signal: AbortSignal,
): Promise<void> {
  if (pending.length === 0) return;

  const POLL_MS = 100;
  while (true) {
    if (signal.aborted) {
      throw createGenerationAbortError("Generation cancelled");
    }
    const state = get();
    const allResolved = pending.every((entry) =>
      isExtractionResolved(state, entry),
    );
    if (allResolved) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
        reject(createGenerationAbortError("Generation cancelled"));
      };
      const timeoutId = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, POLL_MS);
      signal.addEventListener("abort", onAbort);
    });
  }
}

function applyExtractedFilesToPlan(
  state: ReturnType<GenerationStoreGet>,
  plan: GenerationPlan,
  pending: PendingExtractionEntry[],
): void {
  for (const entry of pending) {
    const slot = plan.preprocess.slotValues[entry.inputId];
    if (!slot || slot.type !== "video_selection") continue;
    slot.pendingExtractionRequestId = undefined;

    const value = state.mediaInputs[entry.inputId];
    if (
      !value ||
      value.kind !== "timelineSelection" ||
      value.mediaType !== "video" ||
      value.extractionRequestId !== entry.expectedRequestId
    ) {
      continue;
    }
    if (value.preparedVideoFile) {
      slot.preparedVideoFile = value.preparedVideoFile;
    }
    if (value.preparedMaskFile) {
      slot.preparedMaskFile = value.preparedMaskFile;
    }
    slot.preparedDerivedMaskSignature =
      value.preparedDerivedMaskSignature;
  }
}

function buildGenerationPlanFromState(
  state: ReturnType<GenerationStoreGet>,
  slotValues: Record<string, SlotValue>,
  widgetInputs: Record<string, string>,
  widgetModes: Record<string, "fixed" | "randomize">,
  derivedWidgetInputs: Record<string, string>,
  frontendStateWidgetValues: Record<string, unknown>,
  bypassNodeIds: string[] = [],
): GenerationPlan {
  const workflowId =
    state.rulesWorkflowSourceId ??
    (state.selectedWorkflowId === TEMP_WORKFLOW_ID ||
    isTemporaryWorkflowPersistenceId(state.selectedWorkflowId)
      ? null
      : state.selectedWorkflowId);
  const workflowName = resolveWorkflowDisplayName(
    state.availableWorkflows,
    state.selectedWorkflowId,
    workflowId,
  );
  const projectConfig = {
    aspectRatio: useProjectStore.getState().config.aspectRatio,
    fps: useProjectStore.getState().config.fps,
  };
  const inputMetadata = buildWorkflowInputMetadataMap(
    state.workflowInputs,
    state.mediaInputs,
    projectConfig,
  );
  const providedInputIds = collectProvidedInputIdsFromSlotValues(
    state.workflowInputs,
    slotValues,
  );
  const controlResolutionOptions = {
    frontendStateWidgetValues,
    inputMetadata,
    providedInputIds,
  };
  const postprocessConfig = resolvePostprocessConfig(
    getWorkflowPostprocessingConfig(
      state.activeWorkflowRules,
      controlResolutionOptions,
    ),
  );
  const baseMaskCropMode = getMaskCropModeDefault(state.activeWorkflowRules);
  const resolvedMaskCropMode = getMaskCropModeDefault(
    state.activeWorkflowRules,
    controlResolutionOptions,
  );
  const maskCropMode =
    resolvedMaskCropMode !== baseMaskCropMode
      ? resolvedMaskCropMode
      : state.maskCropMode;

  return createGenerationPlan({
    workflow: state.syncedWorkflow,
    graphData: state.syncedGraphData,
    workflowId,
    workflowRules: state.activeWorkflowRules,
    workflowInputs: state.workflowInputs,
    workflowName,
    mediaInputs: state.mediaInputs,
    slotValues,
    derivedMaskMappings: state.derivedMaskMappings,
    exactAspectRatio: state.exactAspectRatio,
    targetResolution: state.targetResolution,
    maskCropMode,
    maskCropDilation: state.maskCropDilation,
    widgetInputs,
    frontendStateWidgetValues,
    widgetModes,
    derivedWidgetInputs,
    bypassNodeIds,
    postprocessConfig,
    workflowWarnings: state.activeRulesWarnings,
    projectConfig,
  });
}

function cloneSubmittedWorkflow(
  workflow: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
}

interface CapturedSubmittedWorkflow {
  workflow: Record<string, unknown>;
  promptIsPreResolved: boolean;
}

function readWorkflowExpectation(
  state: ReturnType<GenerationStoreGet>,
): GenerationWorkflowExpectation | null {
  return typeof state.iframeWorkflowInstanceId === "string" &&
    typeof state.iframeWorkflowRevision === "number"
    ? {
        workflowInstanceId: state.iframeWorkflowInstanceId,
        revision: state.iframeWorkflowRevision,
      }
    : null;
}

/** Invalid effect targets must fail before any work that can consume GPU time. */
function throwOnGenerationEffectErrors(
  effects: GenerationCapturedEffects,
): void {
  const errors = collectGenerationEffectErrors(effects);
  if (errors.length > 0) {
    throw new Error(
      `Generation rejected before submission: ${errors.join("; ")}`,
    );
  }
}

export class WorkflowOutOfSyncError extends Error {
  readonly expectedWorkflowId: string | null;
  readonly iframeFilename: string | null;

  constructor(expectedWorkflowId: string | null, iframeFilename: string | null) {
    const expected = expectedWorkflowId ?? "the selected workflow";
    const actual = iframeFilename ?? "an unknown workflow";
    super(
      `The ComfyUI editor still has ${actual} loaded but the panel expects ${expected}. ` +
        "Reopen or reload the workflow and try generating again.",
    );
    this.name = "WorkflowOutOfSyncError";
    this.expectedWorkflowId = expectedWorkflowId;
    this.iframeFilename = iframeFilename;
  }
}

// The submitted workflow ALWAYS comes from app.graphToPrompt() — never from
// buildWorkflowFromGraphData. The hosted bridge applies frontend graph
// effects to a temporary clone and lets ComfyUI's graphToPrompt prune it.
async function captureSubmittedWorkflow(
  state: ReturnType<GenerationStoreGet>,
  effects: GenerationCapturedEffects,
): Promise<CapturedSubmittedWorkflow> {
  if (!state.editorRef) {
    throw new Error(
      "ComfyUI editor is not mounted; submission requires graphToPrompt and therefore an open editor iframe",
    );
  }
  if (!effects.expectation) {
    throw new WorkflowOutOfSyncError(state.selectedWorkflowId, null);
  }

  const { bypassNodeIds, widgetOverrides } = buildBridgeEffectPayload(
    effects.effects,
  );
  const resolved = await iframeBridge.resolvePrompt(
    effects.expectation,
    bypassNodeIds,
    widgetOverrides,
  );

  return {
    workflow: cloneSubmittedWorkflow(resolved.output),
    promptIsPreResolved: true,
  };
}

/**
 * Evaluate the effects this dispatch must resolve the prompt from.
 *
 * Runs after preprocessing on purpose: `input_presence` rules have to see the
 * inputs preprocessing derived (a rendered mask an optional derived-mask node
 * needs, say), not just the slot values the plan was built from. Everything
 * read here is detached plan data plus this run's prepared request, so a
 * queued plan still evaluates against the state it was enqueued with.
 *
 * The workflow expectation is the one thing that stays pinned: a queued plan
 * replays the identity captured at enqueue so the bridge rejects a graph that
 * was edited or switched since. A `null` frozen expectation pins nothing (the
 * editor was closed at enqueue), so fall back to the identity that is loaded
 * now — exactly what an immediate submission would resolve against.
 */
function captureDispatchEffects(
  plan: GenerationPlan,
  state: ReturnType<GenerationStoreGet>,
  preparedRequest: GenerationRequest,
): GenerationCapturedEffects {
  return captureGenerationEffectsForPlan(
    plan,
    collectProvidedInputIds(plan, preparedRequest),
    plan.effects?.expectation ?? readWorkflowExpectation(state),
  );
}

async function buildQueuedGenerationPlansFromState(
  state: ReturnType<GenerationStoreGet>,
  slotValues: Record<string, SlotValue>,
  widgetInputs: Record<string, string>,
  widgetModes: Record<string, "fixed" | "randomize">,
  derivedWidgetInputs: Record<string, string>,
  frontendStateWidgetValues: Record<string, unknown>,
  count: number,
  bypassNodeIds: string[] = [],
): Promise<GenerationPlan[]> {
  return Array.from({ length: count }, () =>
    buildGenerationPlanFromState(
      state,
      slotValues,
      widgetInputs,
      widgetModes,
      derivedWidgetInputs,
      frontendStateWidgetValues,
      bypassNodeIds,
    ),
  );
}

async function captureQueuedSubmittedWorkflows(
  plans: GenerationPlan[],
  state: ReturnType<GenerationStoreGet>,
): Promise<GenerationPlan[]> {
  if (plans.length === 0) {
    return plans;
  }

  // Freeze the workflow identity on every queued item at enqueue time — even
  // when the submitted workflow cannot be captured yet — so a deferred
  // dispatch resolves against the graph as it was when the user queued, not
  // whatever is loaded later. Invalid targets fail the whole enqueue, before
  // anything reaches the GPU.
  //
  // The effects themselves are only provisional: they are evaluated from the
  // queued slot values, and preprocessing may still derive inputs that change
  // them (see `captureDispatchEffects`). Dispatch re-evaluates and re-resolves
  // when that happens; the eager capture below is what lets the common,
  // unchanged case run without an open editor.
  const effects = captureGenerationEffectsForPlan(
    plans[0],
    collectProvidedInputIds(plans[0]),
    readWorkflowExpectation(state),
  );
  throwOnGenerationEffectErrors(effects);
  const plansWithEffects = plans.map((plan) => ({ ...plan, effects }));

  if (!state.preResolvedPromptEnabled || !state.editorRef) {
    return plansWithEffects;
  }

  const captured = await captureSubmittedWorkflow(state, effects);

  return plansWithEffects.map((plan) => ({
    ...plan,
    workflow: {
      ...plan.workflow,
      submittedWorkflow: cloneSubmittedWorkflow(captured.workflow),
      promptIsPreResolved: captured.promptIsPreResolved,
      workflowRules: pruneRulesForSubmittedWorkflow(
        plan.workflow.workflowRules,
        captured.workflow,
      ),
    },
  }));
}

function buildGenerationDeliveryContext(
  plan: GenerationPlan,
  workflow: Record<string, unknown> | null,
  autoFamilyRequestKey: string | null,
): GenerationDeliveryContext {
  const saveImageWebsocketNodeIds = getSaveImageWebsocketNodeIds(workflow);
  return {
    planId: plan.id,
    workflowName: plan.metadata.generationMetadata.workflowName,
    workflowSourceId:
      plan.workflow.workflowId ??
      plan.metadata.generationMetadata.workflowSourceId ??
      null,
    generationMetadata: structuredClone(plan.metadata.generationMetadata),
    postprocessConfig: clonePostprocessConfig(plan.postprocess.config),
    autoFamilyRequestKey,
    usesSaveImageWebsocketOutputs: saveImageWebsocketNodeIds.size > 0,
    saveImageWebsocketNodeIds: [...saveImageWebsocketNodeIds],
    replayInputs: plan.metadata.generationMetadata.replayState
      ? {
          replayState: structuredClone(plan.metadata.generationMetadata.replayState),
        }
      : null,
  };
}

function buildSubmissionErrorPatch(
  get: GenerationStoreGet,
  set: GenerationStoreSet,
  error: unknown,
): string {
  const errorJob = createSubmissionErrorJob(error);
  const updated = new Map(get().jobs);
  updated.set(errorJob.id, errorJob);
  set({
    jobs: updated,
    activeJobId: errorJob.id,
    lastAppliedWidgetValues: {},
    pipelineStatus: IDLE_PIPELINE_STATUS,
    preprocessAbortController: null,
  });
  return errorJob.id;
}

export function buildExecutionStoreState(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): GenerationExecutionState {
  let isProcessingQueue = false;
  let generationPreprocessCache: GenerationPreprocessCacheEntry | null = null;

  async function dispatchGenerationPlan(
    plan: GenerationPlan,
  ): Promise<string | null> {
    const pipelineRunToken = get().pipelineRunToken + 1;
    const preprocessAbortController = new AbortController();
    set({
      lastAppliedWidgetValues: {},
      pipelineRunToken,
      preprocessAbortController,
      pipelineStatus: {
        phase: "preprocessing",
        message: "Preparing asset",
        interruptible: true,
      },
    });

    try {
      const state = get();
      const { wsClient, runtimeStatus, runtimeStatusError, connectionStatus } =
        state;
      if (!wsClient) {
        throw new Error("Not connected to ComfyUI");
      }
      if (
        runtimeStatus?.comfyui.status !== "connected" &&
        connectionStatus !== "connected"
      ) {
        throw new Error(
          runtimeStatusError ??
            runtimeStatus?.comfyui.error ??
            "ComfyUI is unavailable",
        );
      }

      // The submission payload MUST come from app.graphToPrompt() — never
      // from buildWorkflowFromGraphData (which is a UI-only helper that
      // emits visual-graph nodes verbatim and would push virtual nodes
      // like MarkdownNote / GetNode at ComfyUI's prompt validator).
      //
      // Skip the async capture when the kill switch is off so this hop
      // doesn't add an extra microtask to dispatch ordering; production
      // keeps the switch on and always awaits.
      let resolvedPlan = plan;
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }

      // If the user clicked Generate while a timeline-selection extraction was
      // still in flight, wait for it now and patch the plan's slot with the
      // resulting prepared files. The cache key below depends on these files,
      // so this must happen before `buildGenerationPreprocessCacheKey`.
      const pendingExtractions = collectPendingExtractions(resolvedPlan);
      if (pendingExtractions.length > 0) {
        await waitForPendingExtractions(
          get,
          pendingExtractions,
          preprocessAbortController.signal,
        );
        if (get().pipelineRunToken !== pipelineRunToken) {
          return null;
        }
        applyExtractedFilesToPlan(get(), resolvedPlan, pendingExtractions);
      }

      const preprocessCacheKey = buildGenerationPreprocessCacheKey(resolvedPlan);
      const matchingPreprocessCache =
        preprocessCacheKey !== null &&
        generationPreprocessCache?.key === preprocessCacheKey
          ? generationPreprocessCache
          : null;

      const prepared = await prepareGenerationPlan(resolvedPlan, {
        clientId: wsClient.currentClientId,
        signal: preprocessAbortController.signal,
        cacheEntry: matchingPreprocessCache,
      });
      let effectivePrepared = prepared;
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }
      // Read live state again: preprocessing can take minutes, and the editor
      // this capture needs may have come or gone in the meantime.
      const captureState = get();
      const frozenEffects = resolvedPlan.effects;
      if (
        captureState.preResolvedPromptEnabled &&
        (resolvedPlan.workflow.submittedWorkflow == null ||
          frozenEffects != null)
      ) {
        const effects = captureDispatchEffects(
          resolvedPlan,
          captureState,
          prepared.request,
        );
        throwOnGenerationEffectErrors(effects);
        // An eagerly captured prompt only stays usable while the effects it
        // was resolved from still hold. When preprocessing changed them the
        // capture is stale, so resolve again against the pinned expectation —
        // failing loudly if the editor is gone beats submitting a prompt that
        // bypasses a node preprocessing just produced the input for.
        const needsCapture =
          resolvedPlan.workflow.submittedWorkflow == null ||
          !frozenEffects ||
          !bridgeEffectPayloadsMatch(frozenEffects, effects);
        if (needsCapture) {
          const captured = await captureSubmittedWorkflow(
            captureState,
            effects,
          );
          resolvedPlan = {
            ...resolvedPlan,
            effects,
            workflow: {
              ...resolvedPlan.workflow,
              submittedWorkflow: cloneSubmittedWorkflow(captured.workflow),
              promptIsPreResolved: captured.promptIsPreResolved,
              workflowRules: pruneRulesForSubmittedWorkflow(
                resolvedPlan.workflow.workflowRules,
                captured.workflow,
              ),
            },
          };
          effectivePrepared = {
            ...prepared,
            plan: resolvedPlan,
          };
        }
      }
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }
      if (preprocessCacheKey !== null && matchingPreprocessCache === null) {
        generationPreprocessCache = buildGenerationPreprocessCacheEntry(
          preprocessCacheKey,
          effectivePrepared,
        );
      }

      // `promptIsPreResolved` tells the backend the prompt topology is already
      // final. The submitted workflow itself is always graphToPrompt output;
      // the prepared request workflow is only a last-ditch fallback when the
      // kill switch is off and no iframe capture happened.
      const submittedWorkflow = resolvedPlan.workflow.submittedWorkflow;
      const usesPreResolvedWorkflow =
        resolvedPlan.workflow.promptIsPreResolved === true;
      const resolvedWorkflow: Record<string, unknown> | null =
        submittedWorkflow ?? effectivePrepared.request.workflow;

      const projectId = useProjectStore.getState().project?.id;
      if (!projectId) {
        throw new Error("No active project is loaded");
      }

      let autoFamilyRequestKey: string | null = null;
      try {
        autoFamilyRequestKey = await buildGenerationFamilyRequestKey({
          workflow:
            effectivePrepared.plan.workflow.graphData ??
            resolvedWorkflow ??
            effectivePrepared.request.workflow,
          workflowInputs: resolvedPlan.workflow.workflowInputs,
          slotValues: resolvedPlan.preprocess.slotValues,
          generationInputs: resolvedPlan.metadata.generationMetadata.inputs,
        });
      } catch (error) {
        console.warn(
          "[Generation] Failed to build auto family request key for delivery context",
          error,
        );
      }

      const deliveryContext = buildGenerationDeliveryContext(
        resolvedPlan,
        resolvedWorkflow,
        autoFamilyRequestKey,
      );

      const response = await comfyApi.generate(
        {
          ...effectivePrepared.request,
          projectId,
          deliveryContext,
          workflow: resolvedWorkflow,
          workflowRules: resolvedPlan.workflow.workflowRules ?? undefined,
          promptIsPreResolved: usesPreResolvedWorkflow,
        },
        {
          signal: preprocessAbortController.signal,
        },
      );
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }

      // Merge first so the cache accumulates good pipeline_outputs across
      // cached runs. If we cached the raw response, an empty stage output
      // (cached preprocess → mask_crop inactive → `mask_processing: {}`)
      // would clobber the cached metadata for every subsequent generation.
      const responseWithCachedPipelineOutputs =
        mergeCachedPipelineOutputsIntoResponse(
          response,
          matchingPreprocessCache,
        );

      if (
        preprocessCacheKey !== null &&
        generationPreprocessCache?.key === preprocessCacheKey
      ) {
        generationPreprocessCache =
          updateGenerationPreprocessCacheFromResponse(
            generationPreprocessCache,
            resolvedPlan,
            responseWithCachedPipelineOutputs,
          );
      }
      const submitted = buildSubmittedGeneration(
        effectivePrepared,
        responseWithCachedPipelineOutputs,
        {
          autoFamilyRequestKey,
        },
      );
      set({
        workflowRuleWarnings: mergeRuleWarnings(
          resolvedPlan.metadata.workflowWarnings,
          submitted.responseWarnings,
        ),
        lastAppliedWidgetValues: submitted.appliedWidgetValues,
      });

      const newJob: import("../types").GenerationJob = {
        id: submitted.promptId,
        deliveryId: submitted.deliveryId,
        status: "queued",
        progress: 0,
        currentNode: null,
        outputs: [],
        error: null,
        submittedAt: Date.now(),
        completedAt: null,
        postprocessConfig: resolvedPlan.postprocess.config,
        aspectRatioProcessing: submitted.aspectRatioProcessing,
        generationMetadata: submitted.generationMetadata,
        postprocessedPreview: null,
        postprocessError: null,
        autoFamilyRequestKey,
        usesSaveImageWebsocketOutputs: submitted.usesSaveImageWebsocketOutputs,
        saveImageWebsocketNodeIds: submitted.saveImageWebsocketNodeIds,
        preparedMaskFile: submitted.preparedMaskFile,
      };

      const updated = new Map(get().jobs);
      updated.set(submitted.promptId, newJob);
      set((state) => {
        if (state.pipelineRunToken !== pipelineRunToken) {
          return {};
        }

        if (state.latestPreviewUrl) {
          URL.revokeObjectURL(state.latestPreviewUrl);
        }
        revokePreviewAnimation(state.previewAnimation);

        const nextPreviewFrames = new Map(state.jobPreviewFrames);
        const previewMode = newJob.postprocessConfig?.mode ?? "auto";
        if (
          newJob.usesSaveImageWebsocketOutputs &&
          (previewMode === "auto" ||
            previewMode === "stitch_frames_with_audio")
        ) {
          nextPreviewFrames.set(submitted.promptId, []);
        } else {
          nextPreviewFrames.delete(submitted.promptId);
        }

        return {
          jobs: updated,
          jobPreviewFrames: nextPreviewFrames,
          activeJobId: submitted.promptId,
          latestPreviewUrl: null,
          previewAnimation: null,
          pipelineStatus: IDLE_PIPELINE_STATUS,
          preprocessAbortController: null,
        };
      });

      return submitted.promptId;
    } catch (error) {
      if (
        isAbortError(error) ||
        preprocessAbortController.signal.aborted ||
        get().pipelineRunToken !== pipelineRunToken
      ) {
        set((state) => {
          if (
            state.pipelineRunToken !== pipelineRunToken &&
            state.preprocessAbortController !== preprocessAbortController
          ) {
            return {};
          }

          return {
            preprocessAbortController: null,
            ...(state.pipelineStatus.phase === "preprocessing"
              ? { pipelineStatus: IDLE_PIPELINE_STATUS }
              : {}),
          };
        });
        return null;
      }

      if (isGpuBusyRejection(error)) {
        // The backend refused admission because vlo's own models own the GPU.
        // Hold the plan rather than failing it: no request stays open, and the
        // ledger subscription resumes the queue when the resource frees. The
        // hold is essential — the ledger may not have caught up with the 409
        // yet, and without it this plan would be resubmitted immediately.
        holdForGpu();
        set((state) => ({
          generationQueue: [plan, ...state.generationQueue],
          preprocessAbortController: null,
          pipelineStatus: {
            phase: "idle",
            message: "Waiting for the GPU",
            interruptible: false,
          },
        }));
        return null;
      }

      generationPreprocessCache = null;
      return buildSubmissionErrorPatch(get, set, error);
    }
  }

  /**
   * Set when the backend refuses admission (409) or the ledger says vlo's own
   * models hold the GPU. Without it the queue would spin: nothing here awaits,
   * so a plan that stays queued would be retried immediately and forever — and
   * a 409 arriving before the ledger update would resubmit at full speed.
   */
  let gpuAdmissionHold = false;
  let gpuAdmissionHoldTimer: ReturnType<typeof setTimeout> | null = null;

  function holdForGpu(): void {
    gpuAdmissionHold = true;
    if (gpuAdmissionHoldTimer !== null) {
      return;
    }
    // A safety net only: the ledger subscription below is the real resume
    // signal, but the queue must not stall forever if that event never lands.
    gpuAdmissionHoldTimer = setTimeout(() => {
      gpuAdmissionHoldTimer = null;
      releaseGpuHold();
    }, GPU_ADMISSION_HOLD_RETRY_MS);
  }

  function releaseGpuHold(): void {
    if (gpuAdmissionHoldTimer !== null) {
      clearTimeout(gpuAdmissionHoldTimer);
      gpuAdmissionHoldTimer = null;
    }
    const wasHeld = gpuAdmissionHold;
    gpuAdmissionHold = false;
    if (wasHeld || get().generationQueue.length > 0) {
      void processGenerationQueue();
    }
  }

  function canDispatchNow(state: ReturnType<GenerationStoreGet>): boolean {
    return (
      Boolean(state.wsClient) &&
      isComfyReadyForDispatch(state) &&
      !gpuAdmissionHold &&
      !isLocalModelWorkHoldingGpu()
    );
  }

  async function processGenerationQueue(): Promise<void> {
    if (isProcessingQueue) {
      return;
    }

    isProcessingQueue = true;
    try {
      while (true) {
        const state = get();
        const activeJob = state.activeJobId
          ? state.jobs.get(state.activeJobId)
          : null;
        if (
          state.pipelineStatus.phase === "preprocessing" ||
          isActiveGenerationJob(activeJob)
        ) {
          return;
        }
        if (!canDispatchNow(state)) {
          // Leave the plan queued; the ledger subscription resumes the queue as
          // soon as vlo's own models hand the GPU back.
          return;
        }

        const [nextPlan, ...remainingQueue] = state.generationQueue;
        if (!nextPlan) {
          return;
        }

        set({ generationQueue: remainingQueue });
        await dispatchGenerationPlan(nextPlan);
      }
    } finally {
      isProcessingQueue = false;

      const state = get();
      const activeJob = state.activeJobId ? state.jobs.get(state.activeJobId) : null;
      if (
        state.generationQueue.length > 0 &&
        state.pipelineStatus.phase !== "preprocessing" &&
        !isActiveGenerationJob(activeJob) &&
        canDispatchNow(state)
      ) {
        void processGenerationQueue();
      }
    }
  }

  async function interruptGeneration(
    options: { clearQueue: boolean },
  ): Promise<void> {
    const {
      pipelineStatus,
      preprocessAbortController,
      pipelineRunToken,
      activeJobId,
      jobs,
    } = get();

    if (options.clearQueue) {
      set({ generationQueue: [] });
    }

    if (pipelineStatus.phase === "preprocessing") {
      preprocessAbortController?.abort();
      set({
        pipelineRunToken: pipelineRunToken + 1,
        preprocessAbortController: null,
        pipelineStatus: IDLE_PIPELINE_STATUS,
      });
      if (!options.clearQueue) {
        void processGenerationQueue();
      }
      return;
    }

    const activeJob = activeJobId ? jobs.get(activeJobId) : null;
    if (!isActiveGenerationJob(activeJob)) {
      if (!options.clearQueue) {
        void processGenerationQueue();
      }
      return;
    }

    set((state) =>
      markJobError(
        state,
        activeJob.id,
        GENERATION_CANCELLED_BY_USER_MESSAGE,
        null,
        {
          clearActiveJob: true,
          completedAt: Date.now(),
        },
      ),
    );

    // The active job's id is its ComfyUI prompt_id. Scope the cancel to it:
    // drop it if still pending, and interrupt only if it is the running prompt.
    // Both are no-ops against the iframe's jobs sharing the global queue.
    try {
      await comfyApi.deleteQueueItems([activeJob.id]);
      await comfyApi.interrupt(activeJob.id);
    } catch (error) {
      const message =
        error instanceof Error
          ? `Cancel failed: ${error.message}`
          : "Cancel failed: ComfyUI is unreachable";
      set((state) =>
        markJobError(state, activeJob.id, message, null, {
          nextConnectionStatus: "error",
          completedAt: Date.now(),
        }),
      );
    }

    if (!options.clearQueue) {
      void processGenerationQueue();
    }
  }

  return {
    pipelineStatus: IDLE_PIPELINE_STATUS,
    pipelineRunToken: 0,
    preprocessAbortController: null,
    lastAppliedWidgetValues: {},
    generationQueue: [],
    postprocessingJobIds: [],

    submitGeneration: async (
      slotValues,
      widgetInputs = {},
      widgetModes = {},
      derivedWidgetInputs = {},
      frontendStateWidgetValues = {},
      bypassNodeIds = [],
    ) => {
      const currentState = get();
      const activeJob = currentState.activeJobId
        ? currentState.jobs.get(currentState.activeJobId)
        : null;
      if (
        currentState.generationQueue.length > 0 ||
        currentState.pipelineStatus.phase === "preprocessing" ||
        isActiveGenerationJob(activeJob)
      ) {
        return null;
      }
      if (currentState.isWorkflowLoading || !currentState.isWorkflowReady) {
        return buildSubmissionErrorPatch(
          get,
          set,
          new Error("Workflow is still loading"),
        );
      }

      const plan = buildGenerationPlanFromState(
        currentState,
        slotValues,
        widgetInputs,
        widgetModes,
        derivedWidgetInputs,
        frontendStateWidgetValues,
        bypassNodeIds,
      );
      return dispatchGenerationPlan(plan);
    },

    queueGeneration: async (
      slotValues,
      widgetInputs = {},
      widgetModes = {},
      derivedWidgetInputs = {},
      count = 1,
      frontendStateWidgetValues = {},
      bypassNodeIds = [],
    ) => {
      const safeCount = Math.max(1, Math.floor(count));
      const currentState = get();
      if (currentState.isWorkflowLoading || !currentState.isWorkflowReady) {
        buildSubmissionErrorPatch(get, set, new Error("Workflow is still loading"));
        return;
      }

      let plans: GenerationPlan[];
      try {
        plans = await buildQueuedGenerationPlansFromState(
          currentState,
          slotValues,
          widgetInputs,
          widgetModes,
          derivedWidgetInputs,
          frontendStateWidgetValues,
          safeCount,
          bypassNodeIds,
        );
        plans = await captureQueuedSubmittedWorkflows(plans, currentState);
      } catch (error) {
        buildSubmissionErrorPatch(get, set, error);
        return;
      }

      set((state) => ({
        generationQueue: [...state.generationQueue, ...plans],
      }));
      await processGenerationQueue();
    },

    processGenerationQueue,

    resumeGenerationQueueAfterGpuRelease: releaseGpuHold,

    clearGenerationQueue: () => {
      set({ generationQueue: [] });
    },

    interruptCurrentGeneration: async () => {
      await interruptGeneration({ clearQueue: false });
    },

    cancelGeneration: async () => {
      await interruptGeneration({ clearQueue: true });
    },
  };
}
