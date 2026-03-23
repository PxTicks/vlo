import * as comfyApi from "../services/comfyuiApi";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  getClosestWorkflowResolution,
  getSupportedWorkflowResolutions,
  type WorkflowRuleWarning,
} from "../services/workflowRules";
import { injectWorkflowAndRead } from "../services/workflowSyncController";
import { mergeRuleWarnings } from "../services/warnings";
import { buildMediaInputActions } from "./mediaInputActions";
import { pruneMediaInputs } from "./mediaInputState";
import {
  parseMetadataWorkflowInputs,
  resolveMetadataWorkflowMatch,
  restoreMediaInputsFromMetadata,
} from "./metadata";
import {
  LOADED_WORKFLOW_DISPLAY_NAME,
  TEMP_WORKFLOW_ID,
} from "./constants";
import type {
  GenerationStoreGet,
  GenerationStoreSet,
  GenerationWorkflowState,
  TempWorkflow,
} from "./types";
import { EMPTY_WORKFLOW_RULES, applyPresentationRules } from "./workflowState";
import {
  formatWorkflowName,
  removeWorkflowOption,
  resolveWorkflowPersistenceId,
  upsertTempWorkflowOption,
  upsertWorkflowOption,
} from "./workflowCatalog";
import type { WorkflowInput } from "../types";

interface WorkflowStoreStateOptions {
  getNextWorkflowLoadRequestId: () => number;
  isCurrentWorkflowLoadRequestId: (requestId: number) => boolean;
}

export function buildWorkflowStoreState(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
  options: WorkflowStoreStateOptions,
): GenerationWorkflowState {
  return {
    syncedWorkflow: null,
    syncedGraphData: null,
    workflowInputs: [],
    availableWorkflows: [],
    tempWorkflow: null,
    selectedWorkflowId: null,
    isWorkflowLoading: true,
    workflowLoadState: "loading",
    workflowLoadError: null,
    isWorkflowReady: false,
    workflowWarning: null,
    hasInferredInputs: false,
    workflowRuleWarnings: [],
    activeWorkflowRules: null,
    rulesWorkflowSourceId: null,
    activeRulesWarnings: [],
    derivedMaskMappings: [],
    targetResolution: DEFAULT_GENERATION_TARGET_RESOLUTION,
    setTargetResolution: (targetResolution) => set({ targetResolution }),
    maskCropMode: "crop",
    setMaskCropMode: (maskCropMode) => set({ maskCropMode }),
    maskCropDilation: 0.1,
    setMaskCropDilation: (dilation: number) =>
      set({ maskCropDilation: Math.max(0, Math.min(0.5, dilation)) }),
    mediaInputs: {},
    editorRef: null,

    registerEditor: (iframe) => {
      set({ editorRef: iframe });

      const { selectedWorkflowId, isWorkflowLoading, workflowInputs } = get();
      if (!selectedWorkflowId) return;

      if (isWorkflowLoading || workflowInputs.length === 0) {
        void get().loadWorkflow(selectedWorkflowId);
      }
    },

    unregisterEditor: () => set({ editorRef: null }),

    setWorkflowLoading: (loading) =>
      set((state) => ({
        isWorkflowLoading: loading,
        workflowLoadState: loading
          ? "loading"
          : state.syncedWorkflow
            ? "ready"
            : "idle",
        workflowLoadError: loading ? null : state.workflowLoadError,
        isWorkflowReady: !loading && state.syncedWorkflow !== null,
      })),

    setWorkflowLoadState: (workflowLoadState) =>
      set((state) => ({
        workflowLoadState,
        isWorkflowLoading: workflowLoadState === "loading",
        workflowLoadError:
          workflowLoadState === "loading" ? null : state.workflowLoadError,
        isWorkflowReady:
          workflowLoadState === "ready" && state.syncedWorkflow !== null,
      })),

    clearWorkflowWarning: () => set({ workflowWarning: null }),
    clearWorkflowLoadError: () => set({ workflowLoadError: null }),
    ...buildMediaInputActions(set, get),

    syncWorkflow: (workflow, graphData, inputs) => {
      const state = get();
      const presented = applyPresentationRules(
        inputs,
        state.activeWorkflowRules,
        workflow,
      );
      const workflowRuleWarnings = mergeRuleWarnings(
        state.activeRulesWarnings,
        presented.presentationWarnings,
      );

      set((currentState) => ({
        syncedWorkflow: workflow,
        syncedGraphData: graphData,
        workflowInputs: presented.inputs,
        hasInferredInputs: presented.hasInferredInputs,
        derivedMaskMappings: presented.derivedMaskMappings,
        workflowRuleWarnings,
        workflowLoadError: null,
        mediaInputs: pruneMediaInputs(currentState.mediaInputs, presented.inputs),
        isWorkflowLoading: false,
        workflowLoadState: "ready",
        isWorkflowReady: true,
      }));
    },

    registerWorkflowFromEditor: async (workflow, graphData, inputs, filename) => {
      const state = get();
      const { availableWorkflows, selectedWorkflowId } = state;
      const presented = applyPresentationRules(
        inputs,
        state.activeWorkflowRules,
        workflow,
      );
      const workflowRuleWarnings = mergeRuleWarnings(
        state.activeRulesWarnings,
        presented.presentationWarnings,
      );

      const persistedWorkflowId = resolveWorkflowPersistenceId(
        selectedWorkflowId,
        filename,
      );

      if (persistedWorkflowId) {
        const existingWorkflow = availableWorkflows.find(
          (item) => item.id === persistedWorkflowId,
        );
        const nextAvailable = upsertWorkflowOption(
          removeWorkflowOption(availableWorkflows, TEMP_WORKFLOW_ID),
          {
            id: persistedWorkflowId,
            name: existingWorkflow?.name ?? formatWorkflowName(persistedWorkflowId),
          },
        );

        set((currentState) => ({
          syncedWorkflow: workflow,
          syncedGraphData: graphData,
          workflowInputs: presented.inputs,
          hasInferredInputs: presented.hasInferredInputs,
          derivedMaskMappings: presented.derivedMaskMappings,
          workflowRuleWarnings,
          workflowLoadError: null,
          mediaInputs: pruneMediaInputs(currentState.mediaInputs, presented.inputs),
          selectedWorkflowId: persistedWorkflowId,
          availableWorkflows: nextAvailable,
          tempWorkflow: null,
          isWorkflowLoading: false,
          workflowLoadState: "ready",
          isWorkflowReady: true,
        }));
        return;
      }

      const nextTempWorkflow: TempWorkflow = {
        workflow,
        graphData,
        inputs,
        name: state.tempWorkflow?.name,
        rules: state.activeWorkflowRules,
        rulesSourceId: state.rulesWorkflowSourceId,
        rulesWarnings: state.activeRulesWarnings,
      };
      const nextAvailable = upsertTempWorkflowOption(
        availableWorkflows,
        nextTempWorkflow,
      );

      set((currentState) => ({
        syncedWorkflow: workflow,
        syncedGraphData: graphData,
        workflowInputs: presented.inputs,
        hasInferredInputs: presented.hasInferredInputs,
        derivedMaskMappings: presented.derivedMaskMappings,
        workflowRuleWarnings,
        workflowLoadError: null,
        mediaInputs: pruneMediaInputs(currentState.mediaInputs, presented.inputs),
        selectedWorkflowId: TEMP_WORKFLOW_ID,
        availableWorkflows: nextAvailable,
        tempWorkflow: nextTempWorkflow,
        isWorkflowLoading: false,
        workflowLoadState: "ready",
        isWorkflowReady: true,
      }));
    },

    fetchWorkflows: async () => {
      if (get().connectionStatus === "connected" && !get().objectInfoSynced) {
        await get().syncObjectInfo();
      }
      try {
        const baseWorkflows = await comfyApi.listWorkflows();
        const { tempWorkflow, selectedWorkflowId, availableWorkflows } = get();
        const selectedWorkflow = selectedWorkflowId
          ? availableWorkflows.find((workflow) => workflow.id === selectedWorkflowId)
          : null;

        const mergedWorkflows = selectedWorkflow
          ? upsertWorkflowOption(baseWorkflows, selectedWorkflow)
          : baseWorkflows;

        const workflows = tempWorkflow
          ? upsertTempWorkflowOption(mergedWorkflows, tempWorkflow)
          : removeWorkflowOption(mergedWorkflows, TEMP_WORKFLOW_ID);

        set({ availableWorkflows: workflows });

        const selectedExists =
          !!selectedWorkflowId &&
          workflows.some((workflow) => workflow.id === selectedWorkflowId);

        if (workflows.length > 0 && !selectedExists) {
          void get().loadWorkflow(workflows[0].id);
        }
        set({ workflowLoadError: null });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to fetch available workflows";
        console.error("[Generation] Failed to fetch workflows:", err);
        set((state) => ({
          workflowLoadError: message,
          isWorkflowLoading: false,
          workflowLoadState: state.syncedWorkflow ? "ready" : "error",
          isWorkflowReady: state.syncedWorkflow !== null,
        }));
      }
    },

    loadWorkflow: async (workflowId: string) => {
      const requestId = options.getNextWorkflowLoadRequestId();
      const isStale = () => !options.isCurrentWorkflowLoadRequestId(requestId);
      const {
        editorRef,
        tempWorkflow,
        activeWorkflowRules,
        rulesWorkflowSourceId,
        activeRulesWarnings,
      } = get();
      const isTempWorkflow =
        workflowId === TEMP_WORKFLOW_ID && tempWorkflow !== null;

      const scheduleRetry = (reason: string, delayMs = 750) => {
        if (isTempWorkflow || isStale()) return;
        if (import.meta.env.DEV) {
          console.info("[Generation] Retrying workflow load", {
            workflowId,
            reason,
            delayMs,
          });
        }
        setTimeout(() => {
          const state = get();
          if (state.selectedWorkflowId !== workflowId) return;
          if (!state.editorRef) return;
          void state.loadWorkflow(workflowId);
        }, delayMs);
      };

      set({
        selectedWorkflowId: workflowId,
        isWorkflowLoading: true,
        workflowLoadState: "loading",
        workflowLoadError: null,
        isWorkflowReady: false,
        workflowWarning: null,
        workflowRuleWarnings: [],
      });

      let deferred = false;

      try {
        let graphData: Record<string, unknown>;
        let rules = tempWorkflow?.rules ?? activeWorkflowRules ?? EMPTY_WORKFLOW_RULES;
        let rulesSourceId =
          tempWorkflow?.rulesSourceId ?? rulesWorkflowSourceId;
        let rulesWarnings =
          tempWorkflow?.rulesWarnings ?? activeRulesWarnings;

        if (isTempWorkflow && tempWorkflow) {
          graphData = tempWorkflow.graphData;
        } else {
          const [graphResponse, fetchedRules] = await Promise.all([
            comfyApi.getWorkflowContent(workflowId),
            comfyApi
              .getWorkflowRules(workflowId)
              .then((result) => ({
                rules: result.rules,
                warnings: result.warnings ?? [],
              }))
              .catch((error) => ({
                rules: EMPTY_WORKFLOW_RULES,
                warnings: [
                  {
                    code: "rules_fetch_failed",
                    message:
                      error instanceof Error
                        ? error.message
                        : "Failed to fetch workflow rules; defaulting to inferred behavior",
                  },
                ] as WorkflowRuleWarning[],
              })),
          ]);

          graphData = graphResponse;
          rules = fetchedRules.rules;
          rulesWarnings = fetchedRules.warnings;
          rulesSourceId = workflowId;
        }
        if (isStale()) return;

        const supportedResolutions = getSupportedWorkflowResolutions(rules);
        if (supportedResolutions.length > 0) {
          const { targetResolution } = get();
          if (!supportedResolutions.includes(targetResolution)) {
            set({
              targetResolution: getClosestWorkflowResolution(
                targetResolution,
                supportedResolutions,
              ),
            });
          }
        }

        set({
          activeWorkflowRules: rules,
          rulesWorkflowSourceId: rulesSourceId,
          activeRulesWarnings: rulesWarnings,
          maskCropMode: rules.mask_cropping.mode,
        });

        if (isTempWorkflow && tempWorkflow) {
          const presented = applyPresentationRules(
            tempWorkflow.inputs,
            rules,
            tempWorkflow.workflow,
          );
          const mergedWarnings = mergeRuleWarnings(
            rulesWarnings,
            presented.presentationWarnings,
          );
          set((state) => ({
            syncedWorkflow: tempWorkflow.workflow,
            syncedGraphData: graphData,
            workflowInputs: presented.inputs,
            hasInferredInputs: presented.hasInferredInputs,
            derivedMaskMappings: presented.derivedMaskMappings,
            workflowRuleWarnings: mergedWarnings,
            mediaInputs: pruneMediaInputs(state.mediaInputs, presented.inputs),
          }));
        } else {
          set({
            syncedGraphData: graphData,
            workflowRuleWarnings: rulesWarnings,
          });
        }

        if (editorRef) {
          const syncResult = await injectWorkflowAndRead(
            editorRef,
            graphData,
            workflowId,
            isStale,
            get().inputNodeMap,
          );
          if (isStale()) return;

          if (syncResult.warnings) {
            set({ workflowWarning: syncResult.warnings });
          }

          if (!syncResult.ok) {
            console.warn(
              "[Generation] Failed to inject workflow",
              syncResult.reason ?? undefined,
            );
          }

          if (syncResult.workflowResult) {
            get().syncWorkflow(
              syncResult.workflowResult.workflow,
              syncResult.workflowResult.graphData,
              syncResult.workflowResult.inputs,
            );
          } else if (!isTempWorkflow && syncResult.deferred) {
            deferred = true;
            if (syncResult.reason === "inputs not found after injection") {
              scheduleRetry(syncResult.reason, 500);
            } else {
              scheduleRetry(syncResult.reason ?? "workflow sync deferred");
            }
          }
        } else {
          deferred = !isTempWorkflow;
        }
      } catch (err) {
        console.error("[Generation] Failed to load workflow:", err);
        deferred = false;
        if (!isStale()) {
          const message =
            err instanceof Error
              ? err.message
              : "Failed to load workflow inputs";
          set({
            workflowLoadError: message,
            isWorkflowLoading: false,
            workflowLoadState: "error",
            isWorkflowReady: false,
          });
        }
      } finally {
        const stale = isStale();
        if (!deferred && !stale) {
          set((state) => ({
            isWorkflowLoading: false,
            workflowLoadState: state.syncedWorkflow ? "ready" : "error",
            isWorkflowReady: state.syncedWorkflow !== null,
          }));
        }
      }
    },

    loadWorkflowFromAssetMetadata: async (asset) => {
      const metadata = asset.creationMetadata;
      if (metadata?.source !== "generated") {
        throw new Error("Only generated assets can be regenerated from metadata");
      }

      const workflow =
        metadata.comfyuiPrompt ?? metadata.comfyuiWorkflow ?? null;
      const graphData =
        metadata.comfyuiWorkflow ?? metadata.comfyuiPrompt ?? null;
      if (!workflow || !graphData) {
        throw new Error("This asset does not include saved workflow metadata");
      }

      set({
        isWorkflowLoading: true,
        workflowLoadState: "loading",
        workflowLoadError: null,
        isWorkflowReady: false,
        workflowWarning: null,
        workflowRuleWarnings: [],
      });

      try {
        const state = get();
        const resolvedMatch = await resolveMetadataWorkflowMatch(
          graphData,
          state.availableWorkflows,
        );
        const nextTempWorkflow: TempWorkflow = {
          workflow,
          graphData,
          inputs: parseMetadataWorkflowInputs(
            metadata.comfyuiPrompt ?? null,
            state.inputNodeMap,
          ),
          name: LOADED_WORKFLOW_DISPLAY_NAME,
          rules: resolvedMatch.rules,
          rulesSourceId: resolvedMatch.rulesSourceId,
          rulesWarnings: resolvedMatch.rulesWarnings,
        };

        set({
          tempWorkflow: nextTempWorkflow,
          availableWorkflows: upsertTempWorkflowOption(
            resolvedMatch.availableWorkflows,
            nextTempWorkflow,
          ),
        });

        await get().loadWorkflow(TEMP_WORKFLOW_ID);

        if (metadata.inputs.length > 0) {
          set({
            isWorkflowLoading: true,
            workflowLoadState: "loading",
            workflowLoadError: null,
            isWorkflowReady: false,
          });

          const loadedState = get();
          await restoreMediaInputsFromMetadata(
            metadata,
            loadedState.workflowInputs,
            loadedState.derivedMaskMappings,
            {
              setMediaInputAsset: loadedState.setMediaInputAsset,
              setMediaInputTimelineSelection:
                loadedState.setMediaInputTimelineSelection,
            },
          );

          set((currentState) => ({
            isWorkflowLoading: false,
            workflowLoadState: currentState.syncedWorkflow ? "ready" : "error",
            isWorkflowReady: currentState.syncedWorkflow !== null,
          }));
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load workflow metadata";
        set({
          workflowLoadError: message,
          isWorkflowLoading: false,
          workflowLoadState: "error",
          isWorkflowReady: false,
        });
        throw error;
      }
    },
  };
}
