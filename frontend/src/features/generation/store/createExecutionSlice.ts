import * as comfyApi from "../services/comfyuiApi";
import {
  DEFAULT_WORKFLOW_POSTPROCESSING,
  type WorkflowRuleWarning,
} from "../services/workflowRules";
import { mergeRuleWarnings } from "../services/warnings";
import { frontendPreprocess } from "../utils/pipeline";
import { isAbortError } from "../pipeline/utils/abort";
import { createSubmissionErrorJob } from "./submission";
import { buildGeneratedCreationMetadata, findPreparedMaskFallback } from "./metadata";
import { IDLE_PIPELINE_STATUS, TEMP_WORKFLOW_ID } from "./constants";
import {
  isActiveGenerationJob,
  markActiveJobError,
} from "./jobMutations";
import {
  resolveWorkflowDisplayName,
} from "./workflowCatalog";
import type {
  GenerationExecutionState,
  GenerationStoreGet,
  GenerationStoreSet,
} from "./types";

function getSaveImageWebsocketNodeIds(
  workflow: Record<string, unknown> | null,
): Set<string> {
  const ids = new Set<string>();
  if (!workflow) return ids;

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      continue;
    }
    const nodeClassType = (node as { class_type?: unknown }).class_type;
    if (nodeClassType === "SaveImageWebsocket") {
      ids.add(nodeId);
    }
  }

  return ids;
}

export function createExecutionSlice(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): GenerationExecutionState {
  return {
    pipelineStatus: IDLE_PIPELINE_STATUS,
    pipelineRunToken: 0,
    preprocessAbortController: null,
    lastAppliedWidgetValues: {},

    submitGeneration: async (
      slotValues,
      widgetInputs,
      widgetModes,
      derivedWidgetInputs,
    ) => {
      const currentState = get();
      const activeJob = currentState.activeJobId
        ? currentState.jobs.get(currentState.activeJobId)
        : null;
      if (
        currentState.pipelineStatus.phase !== "idle" ||
        isActiveGenerationJob(activeJob)
      ) {
        return null;
      }

      const pipelineRunToken = currentState.pipelineRunToken + 1;
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
        const {
          wsClient,
          syncedWorkflow,
          syncedGraphData,
          workflowInputs,
          mediaInputs,
          selectedWorkflowId,
          availableWorkflows,
          rulesWorkflowSourceId,
          activeWorkflowRules,
          activeRulesWarnings,
          derivedMaskMappings,
          isWorkflowLoading,
          isWorkflowReady,
          maskCropMode,
          runtimeStatus,
          runtimeStatusError,
          targetResolution,
        } = get();
        if (!wsClient) throw new Error("Not connected to ComfyUI");
        if (
          runtimeStatus?.comfyui.status !== "connected" &&
          currentState.connectionStatus !== "connected"
        ) {
          throw new Error(
            runtimeStatusError ??
              runtimeStatus?.comfyui.error ??
              "ComfyUI is unavailable",
          );
        }
        if (isWorkflowLoading || !isWorkflowReady) {
          throw new Error("Workflow is still loading");
        }
        const workflowId =
          selectedWorkflowId === TEMP_WORKFLOW_ID
            ? rulesWorkflowSourceId
            : selectedWorkflowId;
        const workflowName = resolveWorkflowDisplayName(
          availableWorkflows,
          selectedWorkflowId,
          workflowId,
        );
        const generationMetadata = buildGeneratedCreationMetadata(
          workflowName,
          workflowInputs,
          mediaInputs,
        );

        const request = await frontendPreprocess(
          syncedWorkflow,
          workflowId,
          workflowInputs,
          slotValues,
          wsClient.currentClientId,
          derivedMaskMappings,
          get().maskCropDilation,
          {
            maskCropMode,
            targetResolution,
            signal: preprocessAbortController.signal,
          },
          syncedGraphData,
        );
        if (get().pipelineRunToken !== pipelineRunToken) {
          return null;
        }
        if (widgetInputs && Object.keys(widgetInputs).length > 0) {
          request.widgetInputs = widgetInputs;
        }
        if (widgetModes && Object.keys(widgetModes).length > 0) {
          request.widgetModes = widgetModes;
        }
        if (derivedWidgetInputs && Object.keys(derivedWidgetInputs).length > 0) {
          request.derivedWidgetInputs = derivedWidgetInputs;
        }
        const response = await comfyApi.generate(request, {
          signal: preprocessAbortController.signal,
        });
        if (get().pipelineRunToken !== pipelineRunToken) {
          return null;
        }
        const responseWarnings: WorkflowRuleWarning[] = Array.isArray(
          response.workflow_warnings,
        )
          ? response.workflow_warnings
          : [];
        const appliedWidgetValues = response.applied_widget_values ?? {};
        const aspectRatioProcessing = response.aspect_ratio_processing ?? null;
        if (response.mask_crop_metadata) {
          generationMetadata.maskCropMetadata = response.mask_crop_metadata;
        }
        if (response.comfyui_prompt) {
          generationMetadata.comfyuiPrompt = response.comfyui_prompt;
        }
        if (response.comfyui_workflow) {
          generationMetadata.comfyuiWorkflow = response.comfyui_workflow;
        }

        let preparedMaskFile = findPreparedMaskFallback(
          slotValues,
          derivedMaskMappings,
          workflowInputs,
        );
        if (response.processed_mask_video) {
          const binaryStr = atob(response.processed_mask_video);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i += 1) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          preparedMaskFile = new File(
            [bytes],
            `generation-mask-${crypto.randomUUID()}.webm`,
            {
              type: "video/webm",
            },
          );
        }
        const saveImageWebsocketNodeIds = getSaveImageWebsocketNodeIds(
          request.workflow,
        );
        const usesSaveImageWebsocketOutputs = saveImageWebsocketNodeIds.size > 0;
        set({
          workflowRuleWarnings: mergeRuleWarnings(
            activeRulesWarnings,
            responseWarnings,
          ),
          lastAppliedWidgetValues: appliedWidgetValues,
        });

        const newJob: import("../types").GenerationJob = {
          id: response.prompt_id,
          status: "queued",
          progress: 0,
          currentNode: null,
          outputs: [],
          error: null,
          submittedAt: Date.now(),
          completedAt: null,
          postprocessConfig: activeWorkflowRules?.postprocessing ?? {
            ...DEFAULT_WORKFLOW_POSTPROCESSING,
          },
          aspectRatioProcessing,
          generationMetadata,
          postprocessedPreview: null,
          postprocessError: null,
          usesSaveImageWebsocketOutputs,
          saveImageWebsocketNodeIds,
          preparedMaskFile,
        };

        const updated = new Map(get().jobs);
        updated.set(response.prompt_id, newJob);
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
            nextPreviewFrames.set(response.prompt_id, []);
          } else {
            nextPreviewFrames.delete(response.prompt_id);
          }
          return {
            jobs: updated,
            jobPreviewFrames: nextPreviewFrames,
            activeJobId: response.prompt_id,
            pipelineStatus: IDLE_PIPELINE_STATUS,
            preprocessAbortController: null,
          };
        });

        return response.prompt_id;
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
    },

    cancelGeneration: async () => {
      const {
        pipelineStatus,
        preprocessAbortController,
        pipelineRunToken,
        activeJobId,
        jobs,
      } = get();
      if (pipelineStatus.phase === "preprocessing") {
        preprocessAbortController?.abort();
        set({
          pipelineRunToken: pipelineRunToken + 1,
          preprocessAbortController: null,
          pipelineStatus: IDLE_PIPELINE_STATUS,
        });
        return;
      }

      if (pipelineStatus.phase === "postprocessing") {
        return;
      }

      const activeJob = activeJobId ? jobs.get(activeJobId) : null;
      if (!isActiveGenerationJob(activeJob)) {
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
    },
  };
}
