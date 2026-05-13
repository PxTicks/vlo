import * as comfyApi from "../services/comfyuiApi";
import {
  buildWorkflowResultFromGraphData,
  isIframeAppReady,
} from "../services/workflowBridge";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  getClosestWorkflowResolution,
  getMaskCropDilationDefault,
  getMaskCropModeDefault,
  getSupportedWorkflowResolutions,
  type WorkflowRuleWarning,
} from "../services/workflowRules";
import {
  injectWorkflowAndRead,
  waitForAppReady,
} from "../services/workflowSyncController";
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
  areWorkflowRulesEffectivelyEmpty,
  findLostRuleFragments,
  hasNodeLinkedWorkflowRules,
  haveSubstantialWorkflowOverlap,
  pruneWorkflowRulesForWorkflows,
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

/**
 * How long {@link GenerationWorkflowState.loadWorkflow} will wait inline for
 * the ComfyUI iframe to finish initializing before falling back to a delayed
 * retry. Sized to cover slow cold starts (extension load + node registration
 * + initial workflow restore) without spinning the previous 750ms retry chain
 * that re-fetched backend data on every iteration.
 */
const APP_READY_LOAD_TIMEOUT_MS = 30_000;

/**
 * Fallback delay used only when the inline wait above hit its timeout. The
 * timeout already implies "the iframe is unusually slow"; retrying sooner
 * burns backend fetches without helping.
 */
const APP_NOT_READY_RETRY_DELAY_MS = 2_000;

/**
 * Number of consecutive editor reads that must report the same rule loss
 * before we accept it as real and overwrite the cached rules. Set to 2 so a
 * single transient partial read (ComfyUI mid-update) is ignored, while a
 * genuine workflow change still applies on the next poll.
 */
const SUSPECT_RULE_LOSS_CONFIRMATION_THRESHOLD = 2;

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
    suspectRuleLossCount: 0,
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
        isWorkflowReady: !loading && state.syncedGraphData !== null,
      })),

    setWorkflowLoadState: (workflowLoadState) =>
      set((state) => ({
        workflowLoadState,
        isWorkflowLoading: workflowLoadState === "loading",
        workflowLoadError:
          workflowLoadState === "loading" ? null : state.workflowLoadError,
        isWorkflowReady:
          workflowLoadState === "ready" && state.syncedGraphData !== null,
      })),

    clearWorkflowWarning: () => set({ workflowWarning: null }),
    clearWorkflowLoadError: () => set({ workflowLoadError: null }),
    ...buildMediaInputActions(set, get),

    syncWorkflow: (workflow, graphData, inputs, options) => {
      const markReady = options?.markReady ?? true;
      const state = get();
      const applicableRules = pruneWorkflowRulesForWorkflows(
        [graphData, workflow],
        state.activeWorkflowRules,
      );
      const presented = applyPresentationRules(
        inputs,
        applicableRules,
        workflow,
        graphData,
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
        ...(markReady
          ? {
              isWorkflowLoading: false,
              workflowLoadState: "ready" as const,
              isWorkflowReady: true,
            }
          : {}),
      }));
    },

    registerWorkflowFromEditor: async (workflow, graphData, inputs, filename) => {
      const state = get();
      const { availableWorkflows, selectedWorkflowId, tempWorkflow } = state;
      const currentWorkflowContext = [graphData, workflow];
      const previousWorkflowMatches = haveSubstantialWorkflowOverlap(
        [
          tempWorkflow?.graphData,
          tempWorkflow?.workflow,
          state.syncedGraphData,
          state.syncedWorkflow,
        ],
        currentWorkflowContext,
      );
      const candidateRulesSourceId =
        tempWorkflow?.rulesSourceId ?? state.rulesWorkflowSourceId;
      const prunedCachedRules = pruneWorkflowRulesForWorkflows(
        currentWorkflowContext,
        state.activeWorkflowRules,
      );
      const hasRulelessWorkflowIdentity =
        candidateRulesSourceId !== null &&
        (
          state.activeWorkflowRules === null ||
          areWorkflowRulesEffectivelyEmpty(state.activeWorkflowRules)
        );
      const hasCompatibleRules =
        candidateRulesSourceId !== null &&
        (
          hasRulelessWorkflowIdentity ||
          (
            !areWorkflowRulesEffectivelyEmpty(prunedCachedRules) &&
            (
              previousWorkflowMatches ||
              hasNodeLinkedWorkflowRules(prunedCachedRules)
            )
          )
        );
      let resolvedRules = hasCompatibleRules
        ? prunedCachedRules
        : EMPTY_WORKFLOW_RULES;
      let resolvedRulesSourceId = hasCompatibleRules
        ? candidateRulesSourceId
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
        resolvedRules = pruneWorkflowRulesForWorkflows(
          currentWorkflowContext,
          resolved.rules,
        );
        resolvedRulesWarnings = resolved.warnings ?? [];
        if (
          !hasRulelessWorkflowIdentity &&
          resolvedRulesSourceId &&
          (
            areWorkflowRulesEffectivelyEmpty(resolvedRules) ||
            (!previousWorkflowMatches &&
              !hasNodeLinkedWorkflowRules(resolvedRules))
          )
        ) {
          resolvedRulesSourceId = null;
        }
      } catch (error) {
        console.warn(
          "[Generation] Failed to resolve live workflow rules from editor sync; falling back to cached rules",
          error,
        );
      }

      // Defer destructive rule replacement when the freshly resolved rules
      // have lost stages/nodes/derived widgets that the cached rules already
      // had, AND the new graph clearly belongs to the same workflow we just
      // had. This guards against transient partial `activeState` reads from
      // the iframe (e.g. ComfyUI mid-update during a model change or close)
      // permanently stranding the panel with empty rules.
      //
      // We require:
      //   - identity preserved: the new graph substantially overlaps the
      //     previously synced one (`previousWorkflowMatches`). Filename
      //     match alone is too weak — a different workflow could land in a
      //     tab that happens to share the selected filename, and we'd see
      //     legitimate rule changes incorrectly held back.
      //   - cached rules were non-empty and tied to a known source: nothing
      //     to protect otherwise. (A `rulesWorkflowSourceId === null` state
      //     means the rules are already orphaned from a previous wipe.)
      //   - actual loss: at least one stage / node rule / derived widget /
      //     rewrite / media_fallback present in the cached rules is missing
      //     from the resolved+pruned ones.
      const previousRules = state.activeWorkflowRules;
      const previousRulesProtectable =
        previousRules !== null &&
        !areWorkflowRulesEffectivelyEmpty(previousRules) &&
        state.rulesWorkflowSourceId !== null;
      const lostFragments = previousRulesProtectable
        ? findLostRuleFragments(previousRules, resolvedRules)
        : null;
      const suspectRuleLoss =
        previousWorkflowMatches && lostFragments !== null && lostFragments.hasLoss;
      const nextSuspectCount = suspectRuleLoss
        ? state.suspectRuleLossCount + 1
        : 0;
      const deferDestructiveReplacement =
        suspectRuleLoss &&
        nextSuspectCount < SUSPECT_RULE_LOSS_CONFIRMATION_THRESHOLD;

      if (deferDestructiveReplacement && previousRules) {
        const deferredPresented = applyPresentationRules(
          inputs,
          previousRules,
          workflow,
          graphData,
        );
        const deferredRuleWarnings = mergeRuleWarnings(
          state.activeRulesWarnings,
          deferredPresented.presentationWarnings,
        );

        console.warn(
          "[Generation] Editor read reported rule loss while workflow identity is preserved; deferring destructive rule replacement",
          {
            lostFragments,
            suspectRuleLossCount: nextSuspectCount,
            rulesWorkflowSourceId: state.rulesWorkflowSourceId,
          },
        );

        set((currentState) => ({
          syncedWorkflow: workflow,
          syncedGraphData: graphData,
          workflowInputs: deferredPresented.inputs,
          hasInferredInputs: deferredPresented.hasInferredInputs,
          derivedMaskMappings: deferredPresented.derivedMaskMappings,
          workflowRuleWarnings: deferredRuleWarnings,
          workflowLoadError: null,
          suspectRuleLossCount: nextSuspectCount,
          mediaInputs: carryOverMediaInputs(
            currentState.workflowInputs,
            currentState.mediaInputs,
            deferredPresented.inputs,
          ),
          isWorkflowLoading: false,
          workflowLoadState: "ready",
          isWorkflowReady: true,
        }));
        return;
      }

      const presented = applyPresentationRules(
        inputs,
        resolvedRules,
        workflow,
        graphData,
      );
      const workflowRuleWarnings = mergeRuleWarnings(
        resolvedRulesWarnings,
        presented.presentationWarnings,
      );

      const candidatePersistedWorkflowId = resolveWorkflowPersistenceId(
        selectedWorkflowId,
        filename,
      );
      const persistedWorkflowId =
        candidatePersistedWorkflowId &&
        candidatePersistedWorkflowId !== TEMP_WORKFLOW_ID &&
        (
          state.activeWorkflowRules === null ||
          areWorkflowRulesEffectivelyEmpty(state.activeWorkflowRules) ||
          hasCompatibleRules ||
          previousWorkflowMatches
        )
          ? candidatePersistedWorkflowId
        : null;

      if (persistedWorkflowId) {
        const existingWorkflow = availableWorkflows.find(
          (item) => item.id === persistedWorkflowId,
        );
        const nextAvailable = upsertWorkflowOption(
          removeWorkflowOption(availableWorkflows, TEMP_WORKFLOW_ID),
          existingWorkflow ?? {
            id: persistedWorkflowId,
            name: formatWorkflowName(persistedWorkflowId),
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
          suspectRuleLossCount: 0,
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
        suspectRuleLossCount: 0,
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
          workflowLoadState: state.syncedGraphData ? "ready" : "error",
          isWorkflowReady: state.syncedGraphData !== null,
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
        suspectRuleLossCount: 0,
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
            tempWorkflow.graphData ?? graphData,
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
          const initialWorkflowResult = buildWorkflowResultFromGraphData(
            graphData,
            workflowId,
            {
              inputNodeMap: get().inputNodeMap,
              objectInfo: get().rawObjectInfo,
            },
          );
          // Optimistic pre-iframe sync: populate panel state for input
          // discovery, but do not mark ready — readiness must wait for the
          // iframe to confirm it has the new graph loaded. Otherwise a
          // deferred injection leaves the panel "ready" while the iframe
          // still holds the previous workflow, and graphToPrompt at submit
          // time returns the wrong graph.
          get().syncWorkflow(
            initialWorkflowResult.workflow,
            initialWorkflowResult.graphData,
            initialWorkflowResult.inputs,
            { markReady: false },
          );
        }

        if (editorRef) {
          // For non-temp workflows, wait inline for the iframe to finish
          // initializing rather than bailing and spinning a tight retry
          // chain. The previous 750ms retry re-fetched backend graph+rules,
          // reset syncedGraphData → null between iterations, and fought the
          // editor's own health-check loop. isStale cancels the wait if the
          // user switches workflows mid-flight.
          //
          // Temp workflows already carry their graph in `tempWorkflow`, so
          // we never have to wait — if the iframe isn't ready synchronously
          // we just skip the inject and let the panel mark ready off the
          // optimistic sync above.
          let appReady = isIframeAppReady(editorRef);
          if (!appReady && !isTempWorkflow) {
            appReady = await waitForAppReady(
              editorRef,
              isStale,
              APP_READY_LOAD_TIMEOUT_MS,
            );
            if (isStale()) return;
          }

          if (appReady) {
            const syncResult = await injectWorkflowAndRead(
              editorRef,
              graphData,
              workflowId,
              isStale,
              get().inputNodeMap,
              get().rawObjectInfo,
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
              // Iframe didn't confirm the new graph. Hold isWorkflowReady
              // false until the scheduled retry succeeds; the finally block
              // checks `deferred` to suppress its readiness flip.
              deferred = true;
              if (syncResult.reason === "inputs not found after injection") {
                scheduleRetry(syncResult.reason, 500);
              } else {
                scheduleRetry(syncResult.reason ?? "workflow sync deferred");
              }
            }
          } else if (!isTempWorkflow) {
            // The inline wait timed out — ComfyUI is unusually slow to come
            // up (or never will). Leave the panel in loading state and let
            // a delayed retry have another go without thrashing the backend.
            deferred = true;
            scheduleRetry("iframe app not ready", APP_NOT_READY_RETRY_DELAY_MS);
          }
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
            workflowLoadState: state.syncedGraphData ? "ready" : "error",
            isWorkflowReady: state.syncedGraphData !== null,
          }));
        }
      }
    },

    loadWorkflowFromAssetMetadata: async (asset) => {
      let assetWithMetadata = asset;
      try {
        const { ensureAssetMetadataLoaded } = await import("../../userAssets");
        assetWithMetadata =
          (await ensureAssetMetadataLoaded(asset.id)) ?? assetWithMetadata;
      } catch (error) {
        console.warn(
          "[Generation] Failed to hydrate asset metadata sidecar before replay:",
          error,
        );
      }

      const metadata = assetWithMetadata.creationMetadata;
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
        suspectRuleLossCount: 0,
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
            workflowLoadState: currentState.syncedGraphData ? "ready" : "error",
            isWorkflowReady: currentState.syncedGraphData !== null,
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
