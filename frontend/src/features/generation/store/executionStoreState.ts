import * as comfyApi from "../services/comfyuiApi";
import { useProjectStore } from "../../project";
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
  GenerationDeliveryContext,
  GenerationPlan,
  GenerationRequest,
  SlotValue,
} from "../pipeline/types";
import {
  evaluateEffectSwitchesForState,
  evaluateRewrites,
  evaluateWidgetDefaultOverrides,
  type RewriteRule,
} from "../services/evaluateRewrites";
import { preResolvePrompt } from "../services/preResolvePrompt";
import { readActiveWorkflowFromIframe } from "../services/workflowBridge";
import { normalizeWorkflowFilename } from "../services/workflowFilenames";
import {
  getWorkflowPostprocessingConfig,
  pruneRulesForSubmittedWorkflow,
} from "../services/workflowRules";
import {
  buildWorkflowInputId,
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
  getWorkflowInputId,
} from "../utils/workflowInputs";
import { haveMatchingWorkflowNodes } from "../utils/workflowNodeSignature";
import {
  createGenerationAbortError,
  isAbortError,
} from "../pipeline/utils/abort";
import type { WorkflowPostprocessingConfig } from "../types";
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
      const requestKey = getNodeInputRequestKey(input, workflowInputById);
      if (!requestInputKeys.has(requestKey)) {
        continue;
      }
      ids.add(getWorkflowInputId(input));
      ids.add(input.nodeId);
    }

    // Cached reruns submit backend loader ids instead of fresh file uploads.
    // These still count as present for rewrite/default evaluation, otherwise
    // preResolvePrompt can wrongly bypass the very nodes that need reinjection.
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

  const ids = new Set<string>();
  for (const [id, value] of Object.entries(plan.preprocess.slotValues)) {
    if (value.type === "text") {
      if (typeof value.value === "string" && value.value.trim().length > 0) {
        ids.add(id);
      }
    } else {
      ids.add(id);
    }
  }
  for (const input of plan.workflow.workflowInputs) {
    const nodeId = input.nodeId;
    if (!nodeId) continue;
    const primaryId = input.id ?? `${nodeId}:${input.param}`;
    if (ids.has(primaryId)) {
      ids.add(nodeId);
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
    if (typeof value.preparedDerivedMaskSignature === "string") {
      slot.preparedDerivedMaskSignature = value.preparedDerivedMaskSignature;
    }
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
    maskCropMode: state.maskCropMode,
    maskCropDilation: state.maskCropDilation,
    widgetInputs,
    frontendStateWidgetValues,
    widgetModes,
    derivedWidgetInputs,
    bypassNodeIds,
    postprocessConfig: resolvePostprocessConfig(
      getWorkflowPostprocessingConfig(state.activeWorkflowRules),
    ),
    workflowWarnings: state.activeRulesWarnings,
    projectConfig: {
      aspectRatio: useProjectStore.getState().config.aspectRatio,
      fps: useProjectStore.getState().config.fps,
    },
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

function iframeMatchesExpectedWorkflow(
  iframeFilename: string | null,
  iframeGraphData: Record<string, unknown>,
  expectedWorkflowId: string | null,
  expectedGraphData: Record<string, unknown> | null,
): boolean {
  // Filename match wins when both sides expose one — it's the cheap and
  // definitive identifier. We compare normalized basenames so leading paths
  // like `default_workflows/foo.json` and `foo.json` are treated as equal.
  if (expectedWorkflowId && iframeFilename) {
    const expectedNormalized = normalizeWorkflowFilename(expectedWorkflowId);
    const iframeNormalized = normalizeWorkflowFilename(iframeFilename);
    if (
      expectedNormalized &&
      iframeNormalized &&
      expectedNormalized === iframeNormalized
    ) {
      return true;
    }
  }

  // Fall back to a node-set signature so small in-iframe edits (added widget
  // values, repositioned nodes, even an extra utility node) don't trip the
  // guard. This is the same tolerance used by `matchesExpectedWorkflowResult`
  // in workflowSyncController.
  if (expectedGraphData) {
    return haveMatchingWorkflowNodes(expectedGraphData, iframeGraphData);
  }

  return false;
}

function verifyIframeMatchesPanel(
  iframe: HTMLIFrameElement,
  state: ReturnType<GenerationStoreGet>,
): void {
  const iframeWorkflow = readActiveWorkflowFromIframe(iframe);
  if (!iframeWorkflow) {
    // No active iframe workflow at all — let preResolvePrompt produce its
    // own "graphToPrompt unavailable" error; we don't want to mask that
    // with an out-of-sync message.
    return;
  }

  const expectedWorkflowId =
    state.rulesWorkflowSourceId ??
    (state.selectedWorkflowId === TEMP_WORKFLOW_ID ||
    isTemporaryWorkflowPersistenceId(state.selectedWorkflowId)
      ? null
      : state.selectedWorkflowId);

  if (
    iframeMatchesExpectedWorkflow(
      iframeWorkflow.filename,
      iframeWorkflow.graphData,
      expectedWorkflowId,
      state.syncedGraphData,
    )
  ) {
    return;
  }

  throw new WorkflowOutOfSyncError(
    expectedWorkflowId,
    iframeWorkflow.filename,
  );
}

// The submitted workflow ALWAYS comes from app.graphToPrompt() — never from
// buildWorkflowFromGraphData. We temporarily mutate the live graph using v3
// frontend graph effects, let ComfyUI's graphToPrompt prune it, and submit
// that already-resolved prompt so the backend never performs graph rewrites.
async function captureSubmittedWorkflow(
  plan: GenerationPlan,
  state: ReturnType<GenerationStoreGet>,
  providedInputIdsOverride?: ReadonlySet<string>,
): Promise<CapturedSubmittedWorkflow | null> {
  if (!state.preResolvedPromptEnabled) {
    return null;
  }

  const iframe = state.editorRef;
  if (!iframe) {
    throw new Error(
      "ComfyUI editor is not mounted; submission requires graphToPrompt and therefore an open editor iframe",
    );
  }

  // Belt-and-suspenders guard: even though `isWorkflowReady` should now wait
  // for iframe coherence, the iframe can still drift between readiness and
  // submission (e.g. ComfyUI internal state churn). If it has, fail fast
  // rather than calling graphToPrompt on the wrong graph.
  verifyIframeMatchesPanel(iframe, state);

  const rewrites: RewriteRule[] =
    (plan.workflow.workflowRules?.rewrites as RewriteRule[] | undefined) ?? [];
  const providedInputIds =
    providedInputIdsOverride ?? collectProvidedInputIds(plan);
  const defaultWidgetOverrides = evaluateWidgetDefaultOverrides(
    plan.workflow.workflowRules,
    providedInputIds,
    plan.submission.frontendStateWidgetValues,
    plan.submission.inputMetadata,
  );
  const { bypass, widgetOverrides: rewriteWidgetOverrides } = evaluateRewrites(
    rewrites,
    providedInputIds,
    plan.submission.frontendStateWidgetValues,
    plan.submission.inputMetadata,
  );
  const effectSwitchEffects = evaluateEffectSwitchesForState(
    plan.workflow.workflowRules?.effect_switches ?? [],
    providedInputIds,
    plan.submission.frontendStateWidgetValues,
    plan.submission.inputMetadata,
  );
  const bypassNodeIds = Array.from(
    new Set([
      ...bypass,
      ...effectSwitchEffects.bypass,
      ...plan.submission.bypassNodeIds,
    ]),
  );
  const widgetOverrides: Parameters<typeof preResolvePrompt>[2] = [
    ...defaultWidgetOverrides,
    ...rewriteWidgetOverrides,
    ...effectSwitchEffects.widgetOverrides,
  ];

  const resolved = await preResolvePrompt(iframe, bypassNodeIds, widgetOverrides);
  if (!resolved) {
    throw new Error(
      "graphToPrompt failed; cannot construct submission payload (check that ComfyUI graphToPrompt is available)",
    );
  }

  return {
    workflow: cloneSubmittedWorkflow(resolved.output),
    promptIsPreResolved: true,
  };
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
  if (!state.preResolvedPromptEnabled || !state.editorRef || plans.length === 0) {
    return plans;
  }

  const captured = await captureSubmittedWorkflow(plans[0], state);
  if (!captured) {
    return plans;
  }

  return plans.map((plan) => ({
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
      if (
        resolvedPlan.workflow.submittedWorkflow == null &&
        state.preResolvedPromptEnabled
      ) {
        const captured = await captureSubmittedWorkflow(
          resolvedPlan,
          state,
          collectProvidedInputIds(resolvedPlan, prepared.request),
        );
        if (captured) {
          resolvedPlan = {
            ...resolvedPlan,
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

      generationPreprocessCache = null;
      return buildSubmissionErrorPatch(get, set, error);
    }
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
        if (!state.wsClient || !isComfyReadyForDispatch(state)) {
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
        state.wsClient &&
        isComfyReadyForDispatch(state)
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

    try {
      await comfyApi.interrupt();
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
