import * as comfyApi from "../services/comfyuiApi";
import { buildWorkflowResultFromGraphData } from "../services/workflowBridge";
import { iframeBridge } from "../services/iframeBridgeClient";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  getAspectRatioStage,
  getClosestWorkflowResolution,
  getMaskCropDilationDefault,
  getMaskCropModeDefault,
  getSupportedWorkflowResolutions,
  getWorkflowResolutionLadder,
  getWorkflowStageControl,
  normalizeCustomResolution,
  type WorkflowRules,
  type WorkflowRuleWarning,
} from "../services/workflowRules";
import {
  DEFAULT_ASPECT_RATIO_SELECTION,
  normalizeAspectRatioSelection,
} from "../utils/aspectRatioSelection";
import {
  injectWorkflowAndRead,
  waitForAppReady,
} from "../services/workflowSyncController";
import { mergeRuleWarnings } from "../services/warnings";
import { buildMediaInputActions } from "./mediaInputActions";
import {
  extractReplayPanelState,
  getReplayAspectRatioSelection,
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
  GeneratedCreationInput,
  GeneratedCreationReplayState,
} from "../../../types/Asset";
import { EMPTY_GENERATION_PANEL_VALUES } from "../persistence/generationPanelSnapshot";
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
import { getAssetById } from "../../userAssets/api";
interface WorkflowStoreStateOptions {
  getNextWorkflowLoadRequestId: () => number;
  isCurrentWorkflowLoadRequestId: (requestId: number) => boolean;
}

const METADATA_REPLAY_INPUT_WAIT_TIMEOUT_MS = 4_000;
/** How long a restore waits for the project's asset index to hydrate. */
const RESTORE_ASSET_WAIT_TIMEOUT_MS = 15_000;
const RESTORE_ASSET_WAIT_POLL_MS = 100;

/**
 * Restores are long-running and cross project boundaries, so each one runs
 * against a token. Opening a session invalidates the one before it — a
 * project change is exactly that, and it must strand the restore it interrupts.
 */
let panelRestoreGeneration = 0;

function openPanelRestoreSession(): { isStale: () => boolean } {
  panelRestoreGeneration += 1;
  const generation = panelRestoreGeneration;
  return { isStale: () => generation !== panelRestoreGeneration };
}
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
const MAX_BRIDGE_LOAD_RETRIES = 3;

/**
 * Number of consecutive editor reads that must report the same rule loss
 * before we accept it as real and overwrite the cached rules. Set to 2 so a
 * single transient partial read (ComfyUI mid-update) is ignored, while a
 * genuine workflow change still applies on the next poll.
 */
const SUSPECT_RULE_LOSS_CONFIRMATION_THRESHOLD = 2;

/**
 * Brings `targetResolution` in line with the workflow that just loaded.
 *
 * A legacy `resolutions` whitelist still clamps to its closest entry. A ladder
 * does not clamp — it only reclaims a value that is neither a rung nor a
 * deliberate custom override, handing it the control's own default so a
 * carried-over value from another workflow cannot look like a chosen one.
 */
function reconcileTargetResolutionForRules(
  rules: WorkflowRules | null,
  get: GenerationStoreGet,
  set: GenerationStoreSet,
): void {
  const supportedResolutions = getSupportedWorkflowResolutions(rules);
  const { targetResolution, targetResolutionIsCustom } = get();

  if (supportedResolutions.length > 0) {
    if (!supportedResolutions.includes(targetResolution)) {
      set({
        targetResolution: getClosestWorkflowResolution(
          targetResolution,
          supportedResolutions,
        ),
        targetResolutionIsCustom: false,
      });
    }
    return;
  }

  const ladder = getWorkflowResolutionLadder(rules);
  if (!ladder || targetResolutionIsCustom) return;
  if (ladder.values.includes(targetResolution)) return;

  const controlDefault = getWorkflowStageControl(
    getAspectRatioStage(rules),
    "target_resolution",
  )?.default;
  const fallback =
    typeof controlDefault === "number"
      ? controlDefault
      : (ladder.values[ladder.values.length - 1] ?? targetResolution);
  set({ targetResolution: fallback, targetResolutionIsCustom: false });
}

/**
 * Puts back the panel-wide settings a saved run carried, and queues its
 * per-control values for the panel to hydrate once its inputs are visible.
 * Shared by asset regeneration and by the project's saved panel state.
 */
function applyReplayPanelSettings(
  get: GenerationStoreGet,
  set: GenerationStoreSet,
  replayState: GeneratedCreationReplayState,
): void {
  const rules = get().activeWorkflowRules;
  const replayMaskCropMode = getReplayMaskCropMode(rules, replayState);
  const replayMaskCropDilation = getReplayMaskCropDilation(rules, replayState);

  set({
    exactAspectRatio: replayState.exactAspectRatio ?? false,
    aspectRatioSelection: getReplayAspectRatioSelection(replayState),
    maskCropMode: replayMaskCropMode ?? get().maskCropMode,
    maskCropDilation:
      typeof replayMaskCropDilation === "number"
        ? Math.max(0, Math.min(0.5, replayMaskCropDilation))
        : get().maskCropDilation,
    pendingReplayPanelState: extractReplayPanelState({ replayState }),
  });
}

/**
 * Waits for the asset library to hydrate the assets a saved run referenced.
 *
 * Reopening a project restores the panel and loads the asset index at the
 * same time, and neither waits on the other. Returns the ids that never
 * arrived: on a project whose index is slow (or whose asset is genuinely
 * gone) the rest of the restore still lands.
 */
async function waitForRestorableAssets(
  assetIds: readonly string[],
  isStale: () => boolean,
): Promise<Set<string>> {
  const missing = new Set(assetIds);
  const deadline = Date.now() + RESTORE_ASSET_WAIT_TIMEOUT_MS;

  while (missing.size > 0 && Date.now() < deadline) {
    for (const assetId of [...missing]) {
      if (getAssetById(assetId)) missing.delete(assetId);
    }
    if (missing.size === 0 || isStale()) break;
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, RESTORE_ASSET_WAIT_POLL_MS),
    );
  }

  for (const assetId of [...missing]) {
    if (getAssetById(assetId)) missing.delete(assetId);
  }

  if (missing.size > 0) {
    console.warn(
      "[Generation] Restoring panel state without assets that are not in this project",
      [...missing],
    );
  }

  return missing;
}

/**
 * Seeds the media slots a saved run used. Extraction of timeline selections
 * continues in the background; the panel observes it through `isExtracting`.
 */
interface RestoreSavedMediaInputsOptions {
  isStale?: () => boolean;
  /**
   * Wait for the asset index and skip what never arrives, instead of failing.
   * Set when reopening a project, where the restore and the asset load run
   * concurrently. Regeneration keeps the strict behavior: an asset that is
   * missing there is missing for good, and the user should be told.
   */
  toleratePendingAssets?: boolean;
}

async function restoreSavedMediaInputs(
  get: GenerationStoreGet,
  set: GenerationStoreSet,
  inputs: GeneratedCreationInput[],
  options: RestoreSavedMediaInputsOptions = {},
): Promise<void> {
  if (inputs.length === 0) return;

  const isStale = options.isStale ?? (() => false);

  await waitForReplayWorkflowInputs(get);
  if (isStale()) return;

  set({
    isWorkflowLoading: true,
    workflowLoadState: "loading",
    workflowLoadError: null,
    isWorkflowReady: false,
  });

  try {
    let restorable = inputs;
    if (options.toleratePendingAssets) {
      const missingAssetIds = await waitForRestorableAssets(
        inputs.flatMap((input) =>
          input.kind === "draggedAsset" ? [input.parentAssetId] : [],
        ),
        isStale,
      );
      if (isStale()) return;

      restorable = inputs.filter(
        (input) =>
          input.kind !== "draggedAsset" ||
          !missingAssetIds.has(input.parentAssetId),
      );
    }

    const loadedState = get();
    await restoreMediaInputsFromMetadata(
      { inputs: restorable },
      loadedState.workflowInputs,
      loadedState.derivedMaskMappings,
      {
        setMediaInputAsset: loadedState.setMediaInputAsset,
        setMediaInputFrameWithSelection:
          loadedState.setMediaInputFrameWithSelection,
        setMediaInputTimelineSelection:
          loadedState.setMediaInputTimelineSelection,
        setMediaInputItemOption: loadedState.setMediaInputItemOption,
      },
      { getMediaInputs: () => get().mediaInputs },
    );
  } finally {
    // The loading state above is asserted by hand, so it has to come back
    // down on every path — a throw here must not strand the panel.
    if (!isStale()) {
      set((currentState) => ({
        isWorkflowLoading: false,
        workflowLoadState: currentState.syncedGraphData ? "ready" : "error",
        isWorkflowReady: currentState.syncedGraphData !== null,
      }));
    }
  }
}

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
  const bridgeLoadRetryCounts = new Map<string, number>();

  return {
    syncedWorkflow: null,
    syncedGraphData: null,
    iframeWorkflowInstanceId: null,
    iframeWorkflowRevision: null,
    workflowInputs: [],
    availableWorkflows: [],
    tempWorkflow: null,
    selectedWorkflowId: null,
    isWorkflowLoading: false,
    workflowLoadState: "idle",
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
    targetResolutionIsCustom: false,
    setTargetResolution: (targetResolution, isCustom = false) => {
      const normalized = normalizeCustomResolution(targetResolution);
      if (normalized === null) return;
      set({
        targetResolution: normalized,
        targetResolutionIsCustom: isCustom,
      });
    },
    aspectRatioSelection: DEFAULT_ASPECT_RATIO_SELECTION,
    setAspectRatioSelection: (aspectRatioSelection) =>
      set({
        aspectRatioSelection: normalizeAspectRatioSelection(
          aspectRatioSelection,
        ),
      }),
    preResolvedPromptEnabled: true,
    setPreResolvedPromptEnabled: (preResolvedPromptEnabled) =>
      set({ preResolvedPromptEnabled }),
    exactAspectRatio: false,
    setExactAspectRatio: (exactAspectRatio) => set({ exactAspectRatio }),
    panelValues: EMPTY_GENERATION_PANEL_VALUES,
    setPanelValues: (panelValues) => set({ panelValues }),
    pendingPanelSnapshot: null,
    isRestoringPanelSnapshot: false,
    panelResetToken: 0,
    setPendingPanelSnapshot: (pendingPanelSnapshot) =>
      set({ pendingPanelSnapshot }),

    restorePanelSnapshot: async (snapshot) => {
      // The snapshot stays pending for the whole restore: it is what blocks
      // saving, and a restore that fails or is superseded must leave the
      // project's state on disk untouched rather than record a partial one.
      if (get().isRestoringPanelSnapshot) return;
      const session = openPanelRestoreSession();
      set({ isRestoringPanelSnapshot: true });

      try {
        await get().loadWorkflow(snapshot.workflowId);

        // Project switched, or the user took the panel over while ComfyUI was
        // still loading the workflow. Either way this snapshot is not what
        // belongs on screen any more.
        if (session.isStale()) return;
        if (get().selectedWorkflowId !== snapshot.workflowId) return;
        if (get().workflowLoadState === "error") return;

        if (typeof snapshot.targetResolution === "number") {
          const rules = get().activeWorkflowRules;
          const supportedResolutions = getSupportedWorkflowResolutions(rules);
          const restoredResolution =
            snapshot.targetResolutionIsCustom === true ||
            supportedResolutions.length === 0
              ? snapshot.targetResolution
              : getClosestWorkflowResolution(
                  snapshot.targetResolution,
                  supportedResolutions,
                );
          get().setTargetResolution(
            restoredResolution,
            snapshot.targetResolutionIsCustom === true,
          );
        }

        if (snapshot.replayState) {
          applyReplayPanelSettings(get, set, snapshot.replayState);
        }

        await restoreSavedMediaInputs(get, set, snapshot.inputs, {
          isStale: session.isStale,
          toleratePendingAssets: true,
        });
        if (session.isStale()) return;

        // Restored in full: from here the panel is this project's live state
        // and may be saved over what is on disk.
        set({ pendingPanelSnapshot: null });
      } finally {
        if (!session.isStale()) set({ isRestoringPanelSnapshot: false });
      }
    },

    discardPendingPanelSnapshot: () =>
      set({ pendingPanelSnapshot: null, isRestoringPanelSnapshot: false }),

    clearPanelForProjectChange: () => {
      // Invalidates any restore still in flight, plus the workflow load it is
      // waiting on, so nothing of the outgoing project can land in the
      // incoming one after the switch.
      openPanelRestoreSession();
      options.getNextWorkflowLoadRequestId();

      set((state) => ({
        pendingPanelSnapshot: null,
        isRestoringPanelSnapshot: false,
        pendingReplayPanelState: null,
        panelValues: EMPTY_GENERATION_PANEL_VALUES,
        panelResetToken: state.panelResetToken + 1,
        // Nothing here belongs to the incoming project: media points at the
        // outgoing project's assets and timeline, and the workflow selection
        // would otherwise be saved into a project that never chose it.
        mediaInputs: pruneMediaInputs(state.mediaInputs, []),
        selectedWorkflowId: null,
        tempWorkflow: null,
        availableWorkflows: removeWorkflowOption(
          state.availableWorkflows,
          TEMP_WORKFLOW_ID,
        ),
        syncedWorkflow: null,
        syncedGraphData: null,
        iframeWorkflowInstanceId: null,
        iframeWorkflowRevision: null,
        workflowInputs: [],
        hasInferredInputs: false,
        derivedMaskMappings: [],
        activeWorkflowRules: null,
        rulesWorkflowSourceId: null,
        activeRulesWarnings: [],
        workflowRuleWarnings: [],
        suspectRuleLossCount: 0,
        workflowWarning: null,
        workflowLoadError: null,
        isWorkflowLoading: false,
        workflowLoadState: "idle" as const,
        isWorkflowReady: false,
        targetResolution: DEFAULT_GENERATION_TARGET_RESOLUTION,
        targetResolutionIsCustom: false,
        aspectRatioSelection: DEFAULT_ASPECT_RATIO_SELECTION,
        exactAspectRatio: false,
        maskCropMode: "crop" as const,
        maskCropDilation: 0.1,
      }));
    },
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
      iframeBridge.bindIframe(iframe);

      const {
        selectedWorkflowId,
        isWorkflowLoading,
        workflowInputs,
        preResolvedPromptEnabled,
        iframeWorkflowInstanceId,
        iframeWorkflowRevision,
      } = get();
      if (!selectedWorkflowId) return;

      const needsBridgeIdentity =
        preResolvedPromptEnabled &&
        (typeof iframeWorkflowInstanceId !== "string" ||
          typeof iframeWorkflowRevision !== "number");
      if (
        isWorkflowLoading ||
        workflowInputs.length === 0 ||
        needsBridgeIdentity
      ) {
        void get().loadWorkflow(selectedWorkflowId);
      }
    },

    unregisterEditor: () => {
      iframeBridge.bindIframe(null);
      set({
        editorRef: null,
        iframeWorkflowInstanceId: null,
        iframeWorkflowRevision: null,
      });
    },

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
    clearWorkflowSelection: () => {
      options.getNextWorkflowLoadRequestId();
      bridgeLoadRetryCounts.clear();
      set({
        selectedWorkflowId: null,
        syncedWorkflow: null,
        syncedGraphData: null,
        iframeWorkflowInstanceId: null,
        iframeWorkflowRevision: null,
        workflowInputs: [],
        mediaInputs: {},
        isWorkflowLoading: false,
        workflowLoadState: "idle",
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
        pendingReplayPanelState: null,
        editorOpen: false,
      });
    },
    refreshMissingModelsFromIframe: async () => {
      const { editorRef } = get();
      if (!editorRef) return false;
      try {
        const ok = await iframeBridge.refreshMissingModels();
        if (!ok) return false;
        const warnings = await iframeBridge.readPendingWarnings();
        set({ workflowWarning: warnings });
        return true;
      } catch (error) {
        console.warn("[Generation] Failed to refresh iframe model warnings", error);
        return false;
      }
    },
    ...buildMediaInputActions(set, get),

    syncWorkflow: (workflow, graphData, inputs, options) => {
      const state = get();
      if (state.selectedWorkflowId === null && !state.editorOpen) {
        return;
      }
      const markReady =
        (options?.markReady ?? true) && state.selectedWorkflowId !== null;
      const bridgeIdentity = options?.bridgeIdentity ?? null;
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
        iframeWorkflowInstanceId: bridgeIdentity?.workflowInstanceId ?? null,
        iframeWorkflowRevision: bridgeIdentity?.revision ?? null,
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

    registerWorkflowFromEditor: async (
      workflow,
      graphData,
      inputs,
      filename,
      bridgeIdentity = null,
    ) => {
      const state = get();
      const { availableWorkflows, selectedWorkflowId, tempWorkflow } = state;
      if (selectedWorkflowId === null && !state.editorOpen) {
        return;
      }
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

      const currentState = get();
      if (
        currentState.selectedWorkflowId !== selectedWorkflowId ||
        (selectedWorkflowId === null && !currentState.editorOpen)
      ) {
        return;
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
          iframeWorkflowInstanceId: bridgeIdentity?.workflowInstanceId ?? null,
          iframeWorkflowRevision: bridgeIdentity?.revision ?? null,
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
          iframeWorkflowInstanceId: bridgeIdentity?.workflowInstanceId ?? null,
          iframeWorkflowRevision: bridgeIdentity?.revision ?? null,
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
        iframeWorkflowInstanceId: bridgeIdentity?.workflowInstanceId ?? null,
        iframeWorkflowRevision: bridgeIdentity?.revision ?? null,
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
      // Object-info enriches a workflow after selection, but the lightweight
      // catalog does not depend on it. Start the sync without delaying menu
      // discovery on ComfyUI's much larger object_info response.
      const status = get().connectionStatus;
      const canAttemptSync = status !== "disconnected" && status !== "error";
      if (canAttemptSync && !get().objectInfoSynced) {
        void get().syncObjectInfo();
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

        set({
          availableWorkflows: workflows,
          workflowLoadError: null,
        });
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
      if (get().selectedWorkflowId !== workflowId) {
        bridgeLoadRetryCounts.clear();
      }
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
        if (isStale()) return;
        const nextAttempt = (bridgeLoadRetryCounts.get(workflowId) ?? 0) + 1;
        bridgeLoadRetryCounts.set(workflowId, nextAttempt);
        if (nextAttempt >= MAX_BRIDGE_LOAD_RETRIES) {
          set({
            workflowLoadError: `${reason}. Reconnect the ComfyUI editor and try again.`,
            isWorkflowLoading: false,
            workflowLoadState: "error",
            isWorkflowReady: false,
          });
          return;
        }
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
        iframeWorkflowInstanceId: null,
        iframeWorkflowRevision: null,
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
                rules: result.has_sidecar ? result.rules : EMPTY_WORKFLOW_RULES,
                rulesSourceId: result.has_sidecar ? workflowId : null,
                warnings: result.warnings ?? [],
              }))
              .catch((error) => ({
                rules: EMPTY_WORKFLOW_RULES,
                rulesSourceId: null,
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
          rulesSourceId = fetchedRules.rulesSourceId;
        }
        if (isStale()) return;

        reconcileTargetResolutionForRules(rules, get, set);

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
            iframeWorkflowInstanceId: null,
            iframeWorkflowRevision: null,
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
          // still holds the previous workflow, and clone resolution at submit
          // time targets the wrong workflow instance.
          get().syncWorkflow(
            initialWorkflowResult.workflow,
            initialWorkflowResult.graphData,
            initialWorkflowResult.inputs,
            { markReady: false, bridgeIdentity: null },
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
          // Temp workflows already carry their graph in `tempWorkflow`, but
          // submission still requires an iframe workflow identity for
          // graphToPrompt. Treat them like persisted workflows here so replay
          // cannot expose Generate before the hidden editor confirms the graph.
          let appReady = iframeBridge.isReady;
          if (!appReady) {
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
              bridgeLoadRetryCounts.delete(workflowId);
              get().syncWorkflow(
                syncResult.workflowResult.workflow,
                syncResult.workflowResult.graphData,
                syncResult.workflowResult.inputs,
                {
                  bridgeIdentity:
                    typeof syncResult.workflowResult.workflowInstanceId ===
                      "string" &&
                    typeof syncResult.workflowResult.revision === "number"
                      ? {
                          workflowInstanceId:
                            syncResult.workflowResult.workflowInstanceId,
                          revision: syncResult.workflowResult.revision,
                        }
                      : null,
                },
              );
            } else if (syncResult.deferred) {
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
          } else {
            // The inline wait timed out — ComfyUI is unusually slow to come
            // up (or never will). Leave the panel in loading state and let
            // a delayed retry have another go without thrashing the backend.
            deferred = true;
            scheduleRetry("iframe app not ready", APP_NOT_READY_RETRY_DELAY_MS);
          }
        } else if (isTempWorkflow && get().preResolvedPromptEnabled) {
          // The editor can register one render after metadata replay begins.
          // Keep replay loading in that window; registerEditor will retry the
          // selected workflow once there is an iframe to confirm its identity.
          deferred = true;
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

          // In-editor generations were authored in the ComfyUI editor, so
          // regeneration lands the user back there with the restored graph.
          // Opened only after the load so the editor's init loop cannot race
          // the replay injection with a stale workflow load.
          if (metadata.generatedInEditor === true) {
            get().setEditorOpen(true);
          }
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
          const rules = get().activeWorkflowRules;
          const supportedResolutions = getSupportedWorkflowResolutions(rules);
          const restoredResolution =
            supportedResolutions.length > 0
              ? getClosestWorkflowResolution(
                  savedTargetResolution,
                  supportedResolutions,
                )
              : savedTargetResolution;
          set({
            targetResolution: restoredResolution,
            // A replayed short edge that is not a rung was a custom override
            // when it was generated, and has to stay one through the reload.
            targetResolutionIsCustom: !(
              getWorkflowResolutionLadder(rules)?.values ?? []
            ).includes(restoredResolution),
          });
        }

        const savedReplayState = metadata.replayState;
        if (savedReplayState) {
          applyReplayPanelSettings(get, set, savedReplayState);
        }

        await restoreSavedMediaInputs(get, set, metadata.inputs);
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
