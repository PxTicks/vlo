import * as comfyApi from "../services/comfyuiApi";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  getClosestWorkflowResolution,
  getMaskCropDilationDefault,
  getMaskCropModeDefault,
  getSupportedWorkflowResolutions,
  type WorkflowRuleWarning,
} from "../services/workflowRules";
import { injectWorkflowAndRead } from "../services/workflowSyncController";
import { mergeRuleWarnings } from "../services/warnings";
import { buildMediaInputActions } from "./mediaInputActions";
import {
  extractReplayPanelState,
  getReplayMaskCropDilation,
  getReplayMaskCropMode,
  getReplayTargetResolution,
  parseReplayWorkflowInputs,
  parseMetadataWorkflowInputs,
  resolveMetadataWorkflowMatch,
  restoreMediaInputsFromMetadata,
} from "./metadata";
import {
  canRegenerateFromAssetMetadata,
  resolveMetadataWorkflowNameMatch,
} from "../utils/metadataReplay";
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
import {
  EMPTY_WORKFLOW_RULES,
  applyPresentationRules,
  areWorkflowRulesCompatibleWithWorkflow,
} from "./workflowState";
import {
  formatWorkflowName,
  removeWorkflowOption,
  resolveWorkflowPersistenceId,
  upsertTempWorkflowOption,
  upsertWorkflowOption,
} from "./workflowCatalog";
import { carryOverMediaInputs } from "../utils/workflowInputCarryover";
import { pruneMediaInputs } from "./mediaInputState";
interface WorkflowStoreStateOptions {
  getNextWorkflowLoadRequestId: () => number;
  isCurrentWorkflowLoadRequestId: (requestId: number) => boolean;
}

const METADATA_REPLAY_INPUT_WAIT_TIMEOUT_MS = 4_000;
const METADATA_REPLAY_INPUT_WAIT_POLL_MS = 50;

async function waitForReplayWorkflowInputs(
  get: GenerationStoreGet,
): Promise<void> {
  const deadline = Date.now() + METADATA_REPLAY_INPUT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = get();

    if (state.workflowInputs.length > 0) {
      return;
    }

    if (state.workflowLoadState === "error") {
      throw new Error(
        state.workflowLoadError ?? "Failed to prepare workflow inputs",
      );
    }

    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, METADATA_REPLAY_INPUT_WAIT_POLL_MS),
    );
  }

  throw new Error(
    "Saved generation inputs could not be restored because the workflow inputs were not ready in time",
  );
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
    preResolvedPromptEnabled: true,
    setPreResolvedPromptEnabled: (preResolvedPromptEnabled) =>
      set({ preResolvedPromptEnabled }),
    exactAspectRatio: false,
    setExactAspectRatio: (exactAspectRatio) => set({ exactAspectRatio }),
    maskCropMode: "crop",
    setMaskCropMode: (maskCropMode) => set({ maskCropMode }),
    maskCropDilation: 0.1,
    setMaskCropDilation: (dilation: number) =>
      set({ maskCropDilation: Math.max(0, Math.min(0.5, dilation)) }),
    mediaInputs: {},
    pendingReplayPanelState: null,
    setPendingReplayPanelState: (pendingReplayPanelState) =>
      set({ pendingReplayPanelState }),
    clearPendingReplayPanelState: () => set({ pendingReplayPanelState: null }),
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
        mediaInputs: carryOverMediaInputs(
          currentState.workflowInputs,
          currentState.mediaInputs,
          presented.inputs,
        ),
        isWorkflowLoading: false,
        workflowLoadState: "ready",
        isWorkflowReady: true,
      }));
    },

    registerWorkflowFromEditor: async (workflow, graphData, inputs, filename) => {
      const state = get();
      const { availableWorkflows, selectedWorkflowId, tempWorkflow } = state;
      const hasCompatibleRules =
        // Prefer whichever editor payload still has the full node set.
        // ComfyUI can transiently report a partial visual graph even when the
        // API workflow remains complete after simple widget edits.
        (graphData
          ? areWorkflowRulesCompatibleWithWorkflow(
              graphData,
              state.activeWorkflowRules,
            )
          : false) ||
        areWorkflowRulesCompatibleWithWorkflow(
          workflow,
          state.activeWorkflowRules,
        );
      let resolvedRules = hasCompatibleRules
        ? state.activeWorkflowRules
        : EMPTY_WORKFLOW_RULES;
      const resolvedRulesSourceId = hasCompatibleRules
        ? (tempWorkflow?.rulesSourceId ?? state.rulesWorkflowSourceId)
        : null;
      let resolvedRulesWarnings = hasCompatibleRules
        ? state.activeRulesWarnings
        : [];

      try {
        const resolved = await comfyApi.resolveWorkflowRules({
          workflow,
          graphData,
          workflowId: resolvedRulesSourceId,
        });
        resolvedRules = resolved.rules;
        resolvedRulesWarnings = resolved.warnings ?? [];
      } catch (error) {
        console.warn(
          "[Generation] Failed to resolve live workflow rules from editor sync; falling back to cached rules",
          error,
        );
      }

      const presented = applyPresentationRules(
        inputs,
        resolvedRules,
        workflow,
      );
      const workflowRuleWarnings = mergeRuleWarnings(
        resolvedRulesWarnings,
        presented.presentationWarnings,
      );

      const persistedWorkflowId = hasCompatibleRules
        ? resolveWorkflowPersistenceId(selectedWorkflowId, filename)
        : null;

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
          activeWorkflowRules: resolvedRules,
          rulesWorkflowSourceId: resolvedRulesSourceId,
          activeRulesWarnings: resolvedRulesWarnings,
          mediaInputs: carryOverMediaInputs(
            currentState.workflowInputs,
            currentState.mediaInputs,
            presented.inputs,
          ),
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
        rules: resolvedRules,
        rulesSourceId: resolvedRulesSourceId,
        rulesWarnings: resolvedRulesWarnings,
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
        activeWorkflowRules: resolvedRules,
        rulesWorkflowSourceId: resolvedRulesSourceId,
        activeRulesWarnings: resolvedRulesWarnings,
        mediaInputs: carryOverMediaInputs(
          currentState.workflowInputs,
          currentState.mediaInputs,
          presented.inputs,
        ),
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
        syncedWorkflow: null,
        syncedGraphData: null,
        workflowWarning: null,
        workflowRuleWarnings: [],
        hasInferredInputs: false,
        derivedMaskMappings: [],
        pendingReplayPanelState: null,
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
          maskCropMode: getMaskCropModeDefault(rules),
          maskCropDilation: getMaskCropDilationDefault(rules),
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
            mediaInputs: carryOverMediaInputs(
              state.workflowInputs,
              state.mediaInputs,
              presented.inputs,
            ),
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
      if (!canRegenerateFromAssetMetadata(metadata)) {
        throw new Error(
          "This asset does not include saved workflow information for regeneration",
        );
      }

      set((state) => ({
        isWorkflowLoading: true,
        workflowLoadState: "loading",
        workflowLoadError: null,
        isWorkflowReady: false,
        syncedWorkflow: null,
        syncedGraphData: null,
        workflowWarning: null,
        workflowRuleWarnings: [],
        hasInferredInputs: false,
        derivedMaskMappings: [],
        pendingReplayPanelState: null,
        // Regeneration should restore exactly the saved media inputs rather
        // than heuristically carrying over whatever the panel currently holds.
        mediaInputs: pruneMediaInputs(state.mediaInputs, []),
      }));

      try {
        const state = get();
        const workflow =
          metadata.comfyuiPrompt ?? metadata.comfyuiWorkflow ?? null;
        let graphData =
          metadata.comfyuiWorkflow ?? metadata.comfyuiPrompt ?? null;
        const replayState = metadata.replayState ?? null;
        const preferredWorkflowSourceId =
          replayState?.workflowSourceId ?? metadata.workflowSourceId ?? null;
        let availableWorkflows = state.availableWorkflows;
        let preferredRules = EMPTY_WORKFLOW_RULES;
        let preferredRulesWarnings: WorkflowRuleWarning[] = [];
        let preferredRulesSourceId: string | null = null;

        if (preferredWorkflowSourceId) {
          const resolvedPreferredSource = await resolveMetadataWorkflowMatch(
            graphData ?? workflow ?? {},
            state.availableWorkflows,
            preferredWorkflowSourceId,
          );
          availableWorkflows = resolvedPreferredSource.availableWorkflows;
          preferredRules = resolvedPreferredSource.rules;
          preferredRulesWarnings = resolvedPreferredSource.rulesWarnings;
          preferredRulesSourceId = resolvedPreferredSource.rulesSourceId;

          if (!graphData) {
            try {
              graphData = await comfyApi.getWorkflowContent(preferredWorkflowSourceId);
            } catch (error) {
              console.warn(
                "[Generation] Failed to load authored workflow graph for metadata replay:",
                preferredWorkflowSourceId,
                error,
              );
            }
          }
        }

        if (workflow && graphData) {
          const replayWorkflowInputs = parseReplayWorkflowInputs(replayState);
          let resolvedRules = preferredRules;
          let resolvedRulesWarnings = preferredRulesWarnings;
          let resolvedRulesSourceId = preferredRulesSourceId;

          if (!preferredWorkflowSourceId) {
            const resolvedMatch = await resolveMetadataWorkflowMatch(
              graphData,
              availableWorkflows,
              null,
            );
            availableWorkflows = resolvedMatch.availableWorkflows;
            resolvedRules = resolvedMatch.rules;
            resolvedRulesWarnings = resolvedMatch.rulesWarnings;
            resolvedRulesSourceId = resolvedMatch.rulesSourceId;
          }

          const nextTempWorkflow: TempWorkflow = {
            workflow,
            graphData,
            inputs:
              replayWorkflowInputs.length > 0
                ? replayWorkflowInputs
                : parseMetadataWorkflowInputs(
                    metadata.comfyuiPrompt ?? null,
                    state.inputNodeMap,
                  ),
            name: LOADED_WORKFLOW_DISPLAY_NAME,
            rules: resolvedRules,
            rulesSourceId: resolvedRulesSourceId,
            rulesWarnings: resolvedRulesWarnings,
          };

          set({
            tempWorkflow: nextTempWorkflow,
            availableWorkflows: upsertTempWorkflowOption(
              availableWorkflows,
              nextTempWorkflow,
            ),
          });

          await get().loadWorkflow(TEMP_WORKFLOW_ID);
        } else {
          const resolvedWorkflow = await resolveMetadataWorkflowNameMatch(
            metadata.workflowName,
            state.availableWorkflows,
          );

          if (!resolvedWorkflow.matchedWorkflow) {
            throw new Error(
              `Could not find the saved workflow "${metadata.workflowName}"`,
            );
          }

          set({
            availableWorkflows: resolvedWorkflow.availableWorkflows,
          });

          await get().loadWorkflow(resolvedWorkflow.matchedWorkflow.id);
        }

        const savedTargetResolution = getReplayTargetResolution(
          get().activeWorkflowRules,
          metadata,
        );
        if (typeof savedTargetResolution === "number") {
          const supportedResolutions = getSupportedWorkflowResolutions(
            get().activeWorkflowRules,
          );
          set({
            targetResolution:
              supportedResolutions.length > 0
                ? getClosestWorkflowResolution(
                    savedTargetResolution,
                    supportedResolutions,
                  )
                : savedTargetResolution,
          });
        }

        const savedReplayState = metadata.replayState;
        if (savedReplayState) {
          const replayMaskCropMode = getReplayMaskCropMode(
            get().activeWorkflowRules,
            savedReplayState,
          );
          const replayMaskCropDilation = getReplayMaskCropDilation(
            get().activeWorkflowRules,
            savedReplayState,
          );
          set({
            exactAspectRatio: savedReplayState.exactAspectRatio ?? false,
            maskCropMode: replayMaskCropMode ?? get().maskCropMode,
            maskCropDilation:
              typeof replayMaskCropDilation === "number"
                ? Math.max(0, Math.min(0.5, replayMaskCropDilation))
                : get().maskCropDilation,
            pendingReplayPanelState: extractReplayPanelState(metadata),
          });
        }

        if (metadata.inputs.length > 0) {
          await waitForReplayWorkflowInputs(get);

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
              setMediaInputFrameWithSelection:
                loadedState.setMediaInputFrameWithSelection,
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
