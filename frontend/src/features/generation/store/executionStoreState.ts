import * as comfyApi from "../services/comfyuiApi";
import { MIGRATED_WORKFLOW_IDS } from "../services/migratedWorkflows";
import { useProjectStore } from "../../project";
import { mergeRuleWarnings } from "../services/warnings";
import {
  buildSubmittedGeneration,
  createGenerationPlan,
  prepareGenerationPlan,
} from "../pipeline/generationPlan";
import type { GenerationPlan, SlotValue } from "../pipeline/types";
import {
  evaluateRewrites,
  evaluateWidgetDefaultOverrides,
  type RewriteRule,
} from "../services/evaluateRewrites";
import { preResolvePrompt } from "../services/preResolvePrompt";
import { getWorkflowPostprocessingConfig } from "../services/workflowRules";
import { isAbortError } from "../pipeline/utils/abort";
import type { WorkflowPostprocessingConfig } from "../types";
import { createSubmissionErrorJob } from "./submission";
import { IDLE_PIPELINE_STATUS, TEMP_WORKFLOW_ID } from "./constants";
import {
  isActiveGenerationJob,
  markActiveJobError,
} from "./jobMutations";
import { buildGenerationFamilyRequestKey } from "../utils/familyAssignment";
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

function collectProvidedInputIds(
  plan: GenerationPlan,
): Set<string> {
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

function buildGenerationPlanFromState(
  state: ReturnType<GenerationStoreGet>,
  slotValues: Record<string, SlotValue>,
  widgetInputs: Record<string, string>,
  widgetModes: Record<string, "fixed" | "randomize">,
  derivedWidgetInputs: Record<string, string>,
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
    widgetModes,
    derivedWidgetInputs,
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

      const prepared = await prepareGenerationPlan(plan, {
        clientId: wsClient.currentClientId,
        signal: preprocessAbortController.signal,
      });
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }

      const shouldPreResolve =
        state.preResolvedPromptEnabled &&
        typeof plan.workflow.workflowId === "string" &&
        MIGRATED_WORKFLOW_IDS.has(plan.workflow.workflowId);

      let resolvedWorkflow: Record<string, unknown> | null =
        prepared.request.workflow;
      if (shouldPreResolve) {
        const iframe = state.editorRef;
        if (!iframe) {
          throw new Error(
            "ComfyUI editor is not mounted; pre-resolved prompt requires an open editor iframe",
          );
        }
        const rewrites: RewriteRule[] =
          (plan.workflow.workflowRules?.rewrites as RewriteRule[] | undefined) ?? [];
        const providedInputIds = collectProvidedInputIds(plan);
        const defaultWidgetOverrides = evaluateWidgetDefaultOverrides(
          plan.workflow.workflowRules,
          providedInputIds,
        );
        const { bypass, widgetOverrides: rewriteWidgetOverrides } = evaluateRewrites(
          rewrites,
          providedInputIds,
        );
        const preResolved = await preResolvePrompt(
          iframe,
          bypass,
          [...defaultWidgetOverrides, ...rewriteWidgetOverrides],
        );
        if (!preResolved) {
          throw new Error(
            "Pre-resolved prompt generation failed; check that ComfyUI graphToPrompt is available",
          );
        }
        resolvedWorkflow = preResolved.output;
      }

      const response = await comfyApi.generate(
        {
          ...prepared.request,
          workflow: resolvedWorkflow,
          workflowRules: plan.workflow.workflowRules ?? undefined,
          promptIsPreResolved: shouldPreResolve,
        },
        {
          signal: preprocessAbortController.signal,
        },
      );
      if (get().pipelineRunToken !== pipelineRunToken) {
        return null;
      }

      let autoFamilyRequestKey: string | null = null;
      try {
        autoFamilyRequestKey = await buildGenerationFamilyRequestKey({
          workflow:
            prepared.plan.workflow.graphData ??
            response.comfyui_prompt ??
            prepared.request.workflow,
          workflowInputs: plan.workflow.workflowInputs,
          slotValues: plan.preprocess.slotValues,
          generationInputs: plan.metadata.generationMetadata.inputs,
        });
      } catch (error) {
        console.warn(
          "[Generation] Failed to build auto family request key for generated asset",
          error,
        );
      }

      const submitted = buildSubmittedGeneration(prepared, response);
      set({
        workflowRuleWarnings: mergeRuleWarnings(
          plan.metadata.workflowWarnings,
          submitted.responseWarnings,
        ),
        lastAppliedWidgetValues: submitted.appliedWidgetValues,
      });

      const newJob: import("../types").GenerationJob = {
        id: submitted.promptId,
        status: "queued",
        progress: 0,
        currentNode: null,
        outputs: [],
        error: null,
        submittedAt: Date.now(),
        completedAt: null,
        postprocessConfig: plan.postprocess.config,
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

    try {
      await comfyApi.interrupt();
      set((state) =>
        markActiveJobError(state, "Generation cancelled by user", {
          completedAt: Date.now(),
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? `Cancel failed: ${error.message}`
          : "Cancel failed: ComfyUI is unreachable";
      set((state) =>
        markActiveJobError(state, message, {
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
      );
      return dispatchGenerationPlan(plan);
    },

    queueGeneration: async (
      slotValues,
      widgetInputs = {},
      widgetModes = {},
      derivedWidgetInputs = {},
      count = 1,
    ) => {
      const safeCount = Math.max(1, Math.floor(count));
      const currentState = get();
      if (currentState.isWorkflowLoading || !currentState.isWorkflowReady) {
        buildSubmissionErrorPatch(get, set, new Error("Workflow is still loading"));
        return;
      }

      const plans = Array.from({ length: safeCount }, () =>
        buildGenerationPlanFromState(
          currentState,
          slotValues,
          widgetInputs,
          widgetModes,
          derivedWidgetInputs,
        ),
      );

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
