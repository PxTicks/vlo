import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChipProps } from "@mui/material";
import type { Asset } from "../../../types/Asset";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { usePlayerStore } from "../../player/usePlayerStore";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { insertAssetAtTime, frameToTick } from "../../timeline";
import { mediaSecondsToTick, tickToMediaSeconds } from "../../../core/time";
import {
  createPointTimelineSelection,
  createTimelineSelection,
  getDefaultSelectionEnd,
  getTimelineSelectionFromAsset,
  useTimelineSelectionStore,
} from "../../timelineSelection";
import { useGenerationStore } from "../useGenerationStore";
import { useProjectStore } from "../../project";
import type {
  GenerationMediaInputValue,
  WorkflowSelectionConfig,
  WorkflowInput,
  WorkflowInputItemOption,
  WorkflowWidgetInput,
} from "../types";
import type { SlotValue } from "../utils/pipeline";
import {
  captureFramePngAtTick,
  renderTimelineSelectionToMp4,
  pickPrimaryPreparedMaskFile,
  renderTimelineSelectionToMp4WithDerivedMasks,
} from "../utils/inputSelection";
import { buildDerivedMaskRenderSignature } from "../utils/derivedMaskRenderSignature";
import {
  buildEditedTimelineSelection,
  renderSyntheticEditedOutputs,
} from "../utils/miniEditorEdit";
import {
  createAudioSelectionPlaceholderFile,
  extractAudioFromSelection,
} from "../utils/manualSlotMedia";
import {
  captureVideoFrameFile,
  probeVideoDurationTicks,
} from "../../../core/media";
import { useMiniEditorStore } from "../../miniEditor";
import type {
  ResolvedEditorSource,
  MiniEditorEditSpec,
} from "../../miniEditor";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { resolveWidgetInputs } from "../store/workflowState";
import { parseInputsFromGraphData } from "../services/workflowBridge";
import { parseInputsFromApiWorkflow } from "../services/apiWorkflowInputs";
import { addLocalAsset, useAssetStore } from "../../userAssets";
import {
  findWorkflowInputValidationFailures,
  getAspectRatioStage,
  getWorkflowStageControl,
} from "../services/workflowRules";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputSlotValue,
  getWorkflowInputValue,
  parseRepeatableInputSlotId,
  readWorkflowInputSlotValue,
  resolveWorkflowInputKeys,
  resolveWorkflowInputForSlot,
} from "../utils/workflowInputs";
import { resolveExistingAssetForExternalDrop } from "../utils/externalDropAsset";
import { openDroppedVideoFrameExtraction } from "../utils/droppedVideoFrameExtraction";
import {
  collectStalledAudioExtractions,
  collectStalledSelectionExtractions,
  fillAudioSlotWithAsset,
  isAssetSlotExtractionCurrent,
} from "../utils/audioSlotExtraction";
import { isAudioSlotVideoAsset } from "../utils/audioSlotAssets";
import { resolveSelectionConfigFps } from "../utils/selectionFps";
import {
  bumpSlotExtractionRequestIds,
  pickChangedSlotIds,
} from "../utils/slotExtractionRequests";
import {
  hasProvidedMediaInputValue,
  resolveAssetFileForGeneration,
} from "../utils/mediaInputAssets";
import {
  reconcileWidgetValues,
  type WidgetCurrentValueMap,
  type WidgetValueMap,
} from "../utils/widgetValueReconciliation";
import { buildWorkflowInputMetadataMap } from "../utils/inputMetadata";
import { carryOverTextValues } from "../utils/workflowInputCarryover";
import {
  assetMatchesType,
  resolveAssetType,
} from "../../../shared/utils/assetTypeDetection";
import { resolveManualWidgetInputs } from "../services/manualWorkflowWidgets";
import { buildGenerationNodeCatalogue } from "../services/workflowNodeCatalogue";
import {
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateValueKey,
} from "../services/frontendRuleState";
import { shouldShowHistoricalGenerationJob } from "../utils/panelDisplayJob";
import {
  areWidgetValueMapsEqual,
  hydrateReplayRandomizeToggles,
  hydrateReplayTextValues,
  resolveReplayNodeBypassWidgetTargets,
  resolveReplayWidgetValues,
  shouldWaitForReplayPanelHydration,
} from "../utils/replayPanelHydration";
import { parseStoredWidgetValue } from "../utils/storedWidgetValues";
import {
  collectBypassDiscoveryDiagnostics,
  collectBypassDiscoveryNodeIds,
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../utils/loraLoaderWidgets";
import {
  collectDefaultNodeBypassWidgetTargets,
  getNodeBypassWidgetKey,
  isNodeBypassWidgetValue,
  partitionNodeBypassWidgetInputs,
  reconcileNodeBypassWidgetTargets,
} from "../utils/nodeBypassWidgets";

/**
 * Mirrors the render pipeline's `applySelectionConfigDefaults`: a selection
 * value of 1 (or none) counts as unset, and the workflow rule fills it in. The
 * mini editor has to resolve its crop grid the same way, otherwise it accepts a
 * span the pipeline then re-snaps — truncating the crop the user just made.
 */
function resolveGridConstraint(
  selectionValue: number | undefined,
  configValue: number | undefined,
): number {
  if (typeof selectionValue === "number" && selectionValue > 1) {
    return Math.max(1, Math.round(selectionValue));
  }
  if (
    typeof configValue === "number" &&
    Number.isFinite(configValue) &&
    configValue > 0
  ) {
    return Math.max(1, Math.round(configValue));
  }
  return 1;
}

function applySelectionConfigDefaults(
  selection: ReturnType<typeof createTimelineSelection>,
  config: WorkflowSelectionConfig | undefined,
): ReturnType<typeof createTimelineSelection> {
  const next = { ...selection };

  if (
    (typeof next.frameStep !== "number" || next.frameStep <= 0) &&
    typeof config?.frameStep === "number" &&
    Number.isFinite(config.frameStep) &&
    config.frameStep > 0
  ) {
    next.frameStep = Math.max(1, Math.round(config.frameStep));
  }

  if (
    (typeof next.frameOffset !== "number" || next.frameOffset <= 0) &&
    typeof config?.frameOffset === "number" &&
    Number.isFinite(config.frameOffset) &&
    config.frameOffset > 0
  ) {
    next.frameOffset = Math.max(1, Math.round(config.frameOffset));
  }

  return next;
}

function setNodeParamValue(
  current: WidgetValueMap,
  nodeId: string,
  param: string,
  value: unknown,
): WidgetValueMap {
  return {
    ...current,
    [nodeId]: { ...(current[nodeId] ?? {}), [param]: value },
  };
}

interface AudioSelectionExtractionOptions {
  inputId: string;
  timelineSelection: ReturnType<typeof createTimelineSelection>;
  thumbnailFile: File;
  extractionRequestId: number;
  exportFps?: number;
  setMediaInputTimelineSelection: ReturnType<
    typeof useGenerationStore.getState
  >["setMediaInputTimelineSelection"];
  selectionExtractionRequestIdsRef: { current: Record<string, number> };
}

async function extractAudioTimelineSelection({
  inputId,
  timelineSelection,
  thumbnailFile,
  extractionRequestId,
  exportFps,
  setMediaInputTimelineSelection,
  selectionExtractionRequestIdsRef,
}: AudioSelectionExtractionOptions): Promise<void> {
  const preparedAudioFile = await extractAudioFromSelection(timelineSelection, {
    exportFps,
  });
  if (
    selectionExtractionRequestIdsRef.current[inputId] !== extractionRequestId
  ) {
    return;
  }
  setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
    mediaType: "audio",
    isExtracting: false,
    extractionRequestId,
    preparedAudioFile,
    extractionError:
      preparedAudioFile === null
        ? "No audio track was found in the selected timeline range"
        : null,
  });
}

interface VideoSelectionExtractionOptions {
  inputId: string;
  inputNodeId?: string;
  timelineSelection: ReturnType<typeof createTimelineSelection>;
  thumbnailFile: File;
  extractionRequestId: number;
  mode: "rules" | "manual";
  derivedMaskMappings: ReturnType<
    typeof useGenerationStore.getState
  >["derivedMaskMappings"];
  setMediaInputTimelineSelection: ReturnType<
    typeof useGenerationStore.getState
  >["setMediaInputTimelineSelection"];
  selectionExtractionRequestIdsRef: { current: Record<string, number> };
}

async function extractVideoTimelineSelection({
  inputId,
  inputNodeId,
  timelineSelection,
  thumbnailFile,
  extractionRequestId,
  mode,
  derivedMaskMappings,
  setMediaInputTimelineSelection,
  selectionExtractionRequestIdsRef,
}: VideoSelectionExtractionOptions): Promise<void> {
  const nodeMasks =
    mode === "manual"
      ? []
      : derivedMaskMappings.filter(
          (mapping) =>
            mapping.sourceInputId === inputId ||
            (!mapping.sourceInputId && mapping.sourceNodeId === inputNodeId),
        );

  if (nodeMasks.length > 0) {
    const cachedVisualMasks = nodeMasks.filter(
      (mask) => mask.purpose !== "audio_timing",
    );
    const { video, masks } = await renderTimelineSelectionToMp4WithDerivedMasks(
      timelineSelection,
      cachedVisualMasks,
    );
    if (
      selectionExtractionRequestIdsRef.current[inputId] !== extractionRequestId
    ) {
      return;
    }
    setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
      mediaType: "video",
      isExtracting: false,
      extractionRequestId,
      preparedVideoFile: video,
      preparedMaskFile: pickPrimaryPreparedMaskFile(cachedVisualMasks, masks),
      preparedDerivedMaskSignature:
        buildDerivedMaskRenderSignature(cachedVisualMasks),
    });
    return;
  }

  const preparedVideoFile =
    await renderTimelineSelectionToMp4(timelineSelection);
  if (
    selectionExtractionRequestIdsRef.current[inputId] !== extractionRequestId
  ) {
    return;
  }
  setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
    mediaType: "video",
    isExtracting: false,
    extractionRequestId,
    preparedVideoFile,
  });
}

export function useGenerationPanel(mode: "rules" | "manual" = "rules") {
  const editorOpen = useGenerationStore((s) => s.editorOpen);
  const setEditorOpen = useGenerationStore((s) => s.setEditorOpen);
  const [urlAnchorEl, setUrlAnchorEl] = useState<null | HTMLElement>(null);
  const [urlInput, setUrlInput] = useState("");

  // Slot values keyed by workflow input ID
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const previousTextWorkflowInputsRef = useRef<WorkflowInput[]>([]);

  // Widget state
  const [widgetValues, setWidgetValues] = useState<WidgetValueMap>({});
  const widgetValuesRef = useRef<WidgetValueMap>({});
  const widgetInputsRef = useRef<readonly WorkflowWidgetInput[]>([]);
  const widgetCurrentValuesRef = useRef<WidgetCurrentValueMap>({});
  const [randomizeToggles, setRandomizeToggles] = useState<
    Record<string, boolean>
  >({});
  const [bypassedWidgetTargets, setBypassedWidgetTargets] = useState<
    ReadonlySet<string>
  >(new Set());
  const bypassedWidgetTargetsRef = useRef<ReadonlySet<string>>(new Set());
  const bypassWorkflowSourceRef = useRef<string | null>(null);
  const appliedBypassDefaultsRef = useRef<ReadonlySet<string>>(new Set());

  const connectionStatus = useGenerationStore((s) => s.connectionStatus);
  const runtimeStatus = useGenerationStore((s) => s.runtimeStatus);
  const runtimeStatusError = useGenerationStore((s) => s.runtimeStatusError);
  const latestPreviewUrl = useGenerationStore((s) => s.latestPreviewUrl);
  const previewAnimation = useGenerationStore((s) => s.previewAnimation);
  const comfyuiDirectUrl = useGenerationStore((s) => s.comfyuiDirectUrl);
  const rulesWorkflowInputs = useGenerationStore((s) => s.workflowInputs);
  const mediaInputs = useGenerationStore((s) => s.mediaInputs);
  const activeJobId = useGenerationStore((s) => s.activeJobId);
  const jobs = useGenerationStore((s) => s.jobs);
  const pipelineStatus = useGenerationStore((s) => s.pipelineStatus);
  const queuedPlanCount = useGenerationStore((s) => s.generationQueue.length);
  // Prompts already handed to ComfyUI but not yet started. Since the queue is
  // submitted ahead, most of "what is still queued" lives there rather than in
  // the local plan array — which drains as fast as preprocessing allows.
  //
  // The active job is excluded: it is reported separately as the current one
  // (and stays `queued` for as long as ComfyUI has something else in front of
  // it), so counting it here as well would claim one generation more than
  // exists.
  const queuedPromptCount = useGenerationStore((s) => {
    let count = 0;
    for (const job of s.jobs.values()) {
      if (job.status === "queued" && job.id !== s.activeJobId) count += 1;
    }
    return count;
  });
  const queuedGenerationCount = queuedPlanCount + queuedPromptCount;
  const postprocessingCount = useGenerationStore(
    (s) => s.postprocessingJobIds.length,
  );
  const clearGenerationQueue = useGenerationStore(
    (s) => s.clearGenerationQueue,
  );
  const interruptCurrentGeneration = useGenerationStore(
    (s) => s.interruptCurrentGeneration,
  );
  const availableWorkflows = useGenerationStore((s) => s.availableWorkflows);
  const selectedWorkflowId = useGenerationStore((s) => s.selectedWorkflowId);
  const isWorkflowLoading = useGenerationStore((s) => s.isWorkflowLoading);
  const isWorkflowReady = useGenerationStore((s) => s.isWorkflowReady);
  const workflowLoadError = useGenerationStore((s) => s.workflowLoadError);
  const workflowWarning = useGenerationStore((s) => s.workflowWarning);
  const hasInferredInputs = useGenerationStore((s) => s.hasInferredInputs);
  const derivedMaskMappings = useGenerationStore((s) => s.derivedMaskMappings);
  const workflowRuleWarnings = useGenerationStore(
    (s) => s.workflowRuleWarnings,
  );
  const loadWorkflow = useGenerationStore((s) => s.loadWorkflow);
  const setWorkflowLoadState = useGenerationStore(
    (s) => s.setWorkflowLoadState,
  );
  const clearWorkflowWarning = useGenerationStore(
    (s) => s.clearWorkflowWarning,
  );
  const clearWorkflowLoadError = useGenerationStore(
    (s) => s.clearWorkflowLoadError,
  );
  const clearWorkflowSelection = useGenerationStore(
    (s) => s.clearWorkflowSelection,
  );
  const refreshRuntimeStatus = useGenerationStore(
    (s) => s.refreshRuntimeStatus,
  );
  const queueGeneration = useGenerationStore((s) => s.queueGeneration);
  const fetchWorkflows = useGenerationStore((s) => s.fetchWorkflows);
  const setMediaInputAsset = useGenerationStore((s) => s.setMediaInputAsset);
  const setMediaInputFrame = useGenerationStore((s) => s.setMediaInputFrame);
  const setMediaInputFrameWithSelection = useGenerationStore(
    (s) => s.setMediaInputFrameWithSelection,
  );
  const setMediaInputTimelineSelection = useGenerationStore(
    (s) => s.setMediaInputTimelineSelection,
  );
  const reassignMediaInput = useGenerationStore((s) => s.reassignMediaInput);
  const moveMediaInput = useGenerationStore((s) => s.moveMediaInput);
  const setMediaInputItemOption = useGenerationStore(
    (s) => s.setMediaInputItemOption,
  );
  const clearMediaInput = useGenerationStore((s) => s.clearMediaInput);
  const pendingReplayPanelState = useGenerationStore(
    (s) => s.pendingReplayPanelState,
  );
  const clearPendingReplayPanelState = useGenerationStore(
    (s) => s.clearPendingReplayPanelState,
  );
  const selectionExtractionRequestIdsRef = useRef<Record<string, number>>({});

  const activeJob = activeJobId ? (jobs.get(activeJobId) ?? null) : null;

  // Memoize lastCompletedJob calculation to avoid running on every render
  const lastCompletedJob = useGenerationStore((s) => {
    let latest: ReturnType<typeof s.jobs.get> = undefined;
    for (const job of s.jobs.values()) {
      if (!shouldShowHistoricalGenerationJob(job)) {
        continue;
      }
      if (!latest || job.submittedAt > latest.submittedAt) {
        latest = job;
      }
    }
    return latest;
  });

  const displayJob = activeJob ?? lastCompletedJob;

  // Resolve widget inputs from the synced workflow + active rules
  const syncedWorkflow = useGenerationStore((s) => s.syncedWorkflow);
  const syncedGraphData = useGenerationStore((s) => s.syncedGraphData);
  const activeWorkflowRules = useGenerationStore((s) => s.activeWorkflowRules);
  const editorRef = useGenerationStore((s) => s.editorRef);
  const inputNodeMap = useGenerationStore((s) => s.inputNodeMap);
  const rawObjectInfo = useGenerationStore((s) => s.rawObjectInfo);
  const lastAppliedWidgetValues = useGenerationStore(
    (s) => s.lastAppliedWidgetValues,
  );
  const manualWorkflowInputs = useMemo(
    () =>
      syncedWorkflow
        ? parseInputsFromApiWorkflow(
            syncedWorkflow,
            inputNodeMap,
            rawObjectInfo,
          )
        : syncedGraphData
          ? parseInputsFromGraphData(syncedGraphData, {
              inputNodeMap,
              objectInfo: rawObjectInfo,
            })
          : [],
    [inputNodeMap, rawObjectInfo, syncedGraphData, syncedWorkflow],
  );
  const workflowInputs =
    mode === "manual" ? manualWorkflowInputs : rulesWorkflowInputs;
  const projectConfig = useProjectStore((state) => state.config);
  const projectId = useProjectStore((state) => state.project?.id ?? null);
  const workflowInputById = useMemo(
    () => buildWorkflowInputLookup(workflowInputs),
    [workflowInputs],
  );
  const providedInputIds = useMemo(() => {
    const provided = new Set<string>();
    for (const input of workflowInputs) {
      const inputId = getWorkflowInputId(input);
      if (input.inputType === "text") {
        const value =
          getWorkflowInputValue(textValues, input, workflowInputById) ?? "";
        if (value.trim().length > 0) {
          provided.add(inputId);
          provided.add(input.nodeId);
        }
        continue;
      }

      if (
        Array.from(
          {
            length: input.presentation?.repeatable?.max ?? 1,
          },
          (_, index) =>
            getWorkflowInputSlotValue(
              mediaInputs,
              input,
              index,
              workflowInputById,
            ) ?? null,
        ).some((value) =>
          hasProvidedMediaInputValue(
            input.inputType as "image" | "video" | "audio",
            value,
          ),
        )
      ) {
        provided.add(inputId);
        provided.add(input.nodeId);
      }
    }
    return provided;
  }, [mediaInputs, textValues, workflowInputById, workflowInputs]);
  const inputMetadata = useMemo(
    () =>
      buildWorkflowInputMetadataMap(workflowInputs, mediaInputs, projectConfig),
    [mediaInputs, projectConfig, workflowInputs],
  );
  const rulesWidgetInputs = useMemo(
    () =>
      resolveWidgetInputs(syncedWorkflow, activeWorkflowRules, {
        graphData: syncedGraphData,
        objectInfo: rawObjectInfo,
        editorRef,
        providedInputIds,
        inputMetadata,
      }),
    [
      syncedWorkflow,
      activeWorkflowRules,
      syncedGraphData,
      rawObjectInfo,
      editorRef,
      providedInputIds,
      inputMetadata,
    ],
  );
  const manualWidgetInputs = useMemo(
    () =>
      resolveManualWidgetInputs(syncedWorkflow, rawObjectInfo, syncedGraphData),
    [rawObjectInfo, syncedGraphData, syncedWorkflow],
  );
  const baseWidgetInputs =
    mode === "manual" ? manualWidgetInputs : rulesWidgetInputs;
  const generationNodes = useMemo(
    () =>
      buildGenerationNodeCatalogue(
        syncedWorkflow,
        rawObjectInfo,
        syncedGraphData,
      ),
    [rawObjectInfo, syncedGraphData, syncedWorkflow],
  );
  const bypassDiscoveryNodeIds = useMemo(
    () => collectBypassDiscoveryNodeIds(activeWorkflowRules),
    [activeWorkflowRules],
  );
  const autodiscoveredLoraWidgetInputs = useMemo(
    () =>
      resolveAutodiscoveredLoraWidgetInputs(
        generationNodes,
        bypassDiscoveryNodeIds,
      ),
    [bypassDiscoveryNodeIds, generationNodes],
  );
  // An ineffective discovery opt-in is advisory, like other rule warnings.
  useEffect(() => {
    for (const diagnostic of collectBypassDiscoveryDiagnostics(
      generationNodes,
      bypassDiscoveryNodeIds,
    )) {
      console.debug("[GenerationPanel] Workflow rule warning", {
        workflowId: selectedWorkflowId,
        message: diagnostic,
      });
    }
  }, [bypassDiscoveryNodeIds, generationNodes, selectedWorkflowId]);
  const widgetInputs = useMemo(
    () =>
      mergeAutodiscoveredLoraWidgetInputs(
        baseWidgetInputs,
        autodiscoveredLoraWidgetInputs,
      ),
    [autodiscoveredLoraWidgetInputs, baseWidgetInputs],
  );

  useEffect(() => {
    widgetInputsRef.current = widgetInputs;
  }, [widgetInputs]);

  useEffect(() => {
    if (bypassWorkflowSourceRef.current === selectedWorkflowId) return;
    bypassWorkflowSourceRef.current = selectedWorkflowId;
    // A new workflow gets its rule defaults applied afresh.
    appliedBypassDefaultsRef.current = new Set();
    const next = new Set<string>();
    bypassedWidgetTargetsRef.current = next;
    setBypassedWidgetTargets(next);
  }, [selectedWorkflowId]);

  useEffect(() => {
    const reconciliation = reconcileNodeBypassWidgetTargets({
      widgetInputs,
      previousTargets: bypassedWidgetTargetsRef.current,
      appliedDefaults: appliedBypassDefaultsRef.current,
    });
    appliedBypassDefaultsRef.current = reconciliation.appliedDefaults;
    if (!reconciliation.changed) return;
    bypassedWidgetTargetsRef.current = reconciliation.targets;
    setBypassedWidgetTargets(reconciliation.targets);
  }, [widgetInputs]);

  useEffect(() => {
    widgetValuesRef.current = widgetValues;
  }, [widgetValues]);

  useEffect(() => {
    setTextValues((prev) => {
      if (workflowInputs.length === 0 && isWorkflowLoading) {
        return prev;
      }

      const next = carryOverTextValues(
        previousTextWorkflowInputsRef.current,
        prev,
        workflowInputs,
      );
      const changed =
        Object.keys(prev).length !== Object.keys(next).length ||
        Object.entries(next).some(([key, value]) => prev[key] !== value);
      return changed ? next : prev;
    });
    if (workflowInputs.length > 0) {
      previousTextWorkflowInputsRef.current = workflowInputs;
    }
  }, [isWorkflowLoading, workflowInputs]);

  // Reconcile widget values and randomize toggles when widget inputs change.
  //
  // `widgetInputs` is a memo whose identity flips whenever any upstream input
  // (text values, media inputs, providedInputIds, inputMetadata, iframe poll,
  // object-info refresh, etc.) re-renders — even when the widgets themselves
  // are unchanged. Rebuilding `widgetValues` from `currentValue` on every
  // identity flip clobbers any value the user just set in the panel, which
  // shows up as the slider snapping back to its prior position immediately
  // after a click.
  //
  // Instead, reconcile against the last backing value we saw: preserve panel
  // values while currentValue is unchanged, refresh when currentValue really
  // changes, initialize newly-added widgets, and drop disappeared ones.
  useEffect(() => {
    const reconciliation = reconcileWidgetValues({
      widgetInputs,
      previousValues: widgetValuesRef.current,
      previousCurrentValues: widgetCurrentValuesRef.current,
    });

    widgetCurrentValuesRef.current = reconciliation.currentValues;
    if (reconciliation.valuesChanged) {
      widgetValuesRef.current = reconciliation.values;
      setWidgetValues(reconciliation.values);
    }

    const nextToggles: Record<string, boolean> = {};
    for (const w of widgetInputs) {
      if (w.config.controlAfterGenerate) {
        const key = `${w.nodeId}:${w.param}`;
        // Preserve existing toggle state, fall back to workflow's saved mode
        nextToggles[key] =
          randomizeToggles[key] ?? w.config.defaultRandomize ?? true;
      }
    }
    setRandomizeToggles((prev) => ({ ...prev, ...nextToggles }));
    // Only re-run when widgetInputs identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetInputs]);

  // Sync displayed widget values to exactly what the backend applied.
  useEffect(() => {
    const entries = Object.entries(lastAppliedWidgetValues);
    if (entries.length === 0) return;
    setWidgetValues((prev) => {
      const next = { ...prev };
      for (const [key, applied] of entries) {
        const sep = key.lastIndexOf(":");
        if (sep <= 0 || sep >= key.length - 1) continue;
        const nodeId = key.slice(0, sep);
        const param = key.slice(sep + 1);
        next[nodeId] = { ...(next[nodeId] ?? {}), [param]: applied };
      }
      widgetValuesRef.current = next;
      return next;
    });
  }, [lastAppliedWidgetValues]);

  // Hydrate panel state from a queued generation-replay snapshot after the
  // workflow/widget inputs are visible. Doing this in an effect keeps React's
  // render phase pure while still restoring saved seed/widget values once.
  useEffect(() => {
    if (!pendingReplayPanelState) {
      return;
    }

    if (
      shouldWaitForReplayPanelHydration(
        pendingReplayPanelState,
        workflowInputs,
        widgetInputs,
        isWorkflowLoading,
      )
    ) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTextValues(
      (prev) =>
        hydrateReplayTextValues(prev, pendingReplayPanelState, workflowInputs)
          .value,
    );

    const nextWidgetValues = resolveReplayWidgetValues(
      pendingReplayPanelState,
      widgetInputs,
    );
    if (
      nextWidgetValues &&
      !areWidgetValueMapsEqual(widgetValuesRef.current, nextWidgetValues)
    ) {
      widgetValuesRef.current = nextWidgetValues;
      setWidgetValues(nextWidgetValues);
    }

    const nextBypassedWidgetTargets = resolveReplayNodeBypassWidgetTargets(
      pendingReplayPanelState,
      widgetInputs,
    );
    // The replayed generation is an explicit choice about every loader, so
    // rule defaults must not be layered back on top of it afterwards.
    appliedBypassDefaultsRef.current = collectDefaultNodeBypassWidgetTargets(
      widgetInputs,
    );
    bypassedWidgetTargetsRef.current = nextBypassedWidgetTargets;
    setBypassedWidgetTargets(nextBypassedWidgetTargets);

    setRandomizeToggles(
      (prev) =>
        hydrateReplayRandomizeToggles(
          prev,
          pendingReplayPanelState,
          widgetInputs,
        ).value,
    );

    clearPendingReplayPanelState();
  }, [
    clearPendingReplayPanelState,
    isWorkflowLoading,
    pendingReplayPanelState,
    widgetInputs,
    workflowInputs,
  ]);

  useEffect(() => {
    const store = useGenerationStore.getState();
    store.connect();
    void store.refreshRuntimeStatus();

    const intervalId = window.setInterval(() => {
      const current = useGenerationStore.getState();
      // Also tick while !objectInfoSynced so a transient sync failure (e.g.
      // ComfyUI briefly unreachable when the WS first connected) gets a
      // retry via refreshRuntimeStatus → syncObjectInfo. Once the sync
      // succeeds and the connection is healthy the poll falls idle.
      if (
        current.connectionStatus !== "connected" ||
        current.workflowLoadError !== null ||
        !current.objectInfoSynced
      ) {
        void current.refreshRuntimeStatus();
      }
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [projectId]);

  const handleGenerate = useCallback(
    async (count = 1) => {
      const store = useGenerationStore.getState();
      const currentWidgetValues = widgetValuesRef.current;

      if (store.connectionStatus !== "connected") {
        store.connect();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Build slot values from current UI state
      const slotValues: Record<string, SlotValue> = {};
      const bypassNodeIds = new Set<string>();
      const activateNodeIds = new Set<string>();

      for (const input of workflowInputs) {
        const inputId = getWorkflowInputId(input);
        if (input.inputType === "text") {
          const text =
            getWorkflowInputValue(textValues, input, workflowInputById) ?? "";
          slotValues[inputId] = { type: "text", value: text };
        } else {
          const repeatableMax = input.presentation?.repeatable?.max ?? 1;
          const mediaEntries = Array.from(
            { length: repeatableMax },
            (_, index) => {
              const slotInputId = buildRepeatableInputSlotId(input, index);
              return [
                slotInputId,
                getWorkflowInputSlotValue(
                  store.mediaInputs,
                  input,
                  index,
                  workflowInputById,
                ) ?? null,
              ] as const;
            },
          ).filter(
            (entry): entry is readonly [string, GenerationMediaInputValue] =>
              entry[1] !== null,
          );
          if (mediaEntries.length === 0) {
            if (mode === "manual") {
              bypassNodeIds.add(input.nodeId);
            }
            continue;
          }

          for (const [slotInputId, value] of mediaEntries) {
            if (input.inputType === "image") {
              if (value.kind === "asset") {
                if (!assetMatchesType(value.asset, "image")) {
                  continue;
                }
                const file = await resolveAssetFileForGeneration(value.asset);
                slotValues[slotInputId] = {
                  type: "image",
                  file,
                };
              } else if (value.kind === "frame") {
                slotValues[slotInputId] = {
                  type: "image",
                  file: value.file,
                };
              }
              continue;
            }

            if (input.inputType === "audio") {
              if (value.kind === "asset") {
                if (isAudioSlotVideoAsset(value.asset)) {
                  // A video dropped on an audio slot submits the audio track
                  // extracted when it was dropped, never the video itself.
                  if (!value.extractedAudioFile) {
                    continue;
                  }
                  slotValues[slotInputId] = {
                    type: "audio",
                    file: value.extractedAudioFile,
                  };
                  continue;
                }
                if (!assetMatchesType(value.asset, "audio")) {
                  continue;
                }
                const file = await resolveAssetFileForGeneration(value.asset);
                slotValues[slotInputId] = {
                  type: "audio",
                  file,
                };
              } else if (
                value.kind === "timelineSelection" &&
                value.mediaType === "audio" &&
                value.preparedAudioFile
              ) {
                slotValues[slotInputId] = {
                  type: "audio",
                  file: value.preparedAudioFile,
                };
              }
              continue;
            }

            if (value.kind === "asset") {
              if (!assetMatchesType(value.asset, "video")) {
                continue;
              }
              const file = await resolveAssetFileForGeneration(value.asset);
              slotValues[slotInputId] = {
                type: "video",
                file,
                assetId: value.asset.id,
                ...(typeof value.includeEmbeddedAudio === "boolean"
                  ? { includeEmbeddedAudio: value.includeEmbeddedAudio }
                  : {}),
              };
              continue;
            }

            if (
              value.kind === "timelineSelection" &&
              value.mediaType === "video"
            ) {
              slotValues[slotInputId] = {
                type: "video_selection",
                selection: value.timelineSelection,
                preparedVideoFile: value.preparedVideoFile ?? undefined,
                preparedMaskFile: value.preparedMaskFile ?? undefined,
                preparedDerivedMaskSignature:
                  value.preparedDerivedMaskSignature,
                pendingExtractionRequestId: value.isExtracting
                  ? value.extractionRequestId
                  : undefined,
                ...(typeof value.includeEmbeddedAudio === "boolean"
                  ? { includeEmbeddedAudio: value.includeEmbeddedAudio }
                  : {}),
              };
            }
          }
        }
      }

      // Build widget overrides and randomization modes.
      // Actual random number generation happens in the backend to preserve
      // precision for large integer domains (for example seed ranges).
      const widgetOverrides: Record<string, string> = {};
      const frontendStateWidgetValues: Record<string, unknown> = {};
      const derivedWidgetInputs: Record<string, string> = {};
      const widgetModes: Record<string, "fixed" | "randomize"> = {};
      const widgetSubmission = partitionNodeBypassWidgetInputs(
        widgetInputsRef.current,
        bypassedWidgetTargetsRef.current,
      );
      for (const nodeId of widgetSubmission.bypassNodeIds) {
        bypassNodeIds.add(nodeId);
      }
      for (const nodeId of widgetSubmission.activateNodeIds) {
        activateNodeIds.add(nodeId);
      }
      for (const w of widgetSubmission.activeWidgetInputs) {
        const value =
          currentWidgetValues[w.nodeId]?.[w.param] ?? w.currentValue;
        if (w.kind === "derived") {
          if (value !== undefined && value !== null) {
            derivedWidgetInputs[`derived_widget_${w.derivedWidgetId}`] =
              String(value);
            frontendStateWidgetValues[
              buildFrontendStateDerivedWidgetKey(w.derivedWidgetId)
            ] =
              typeof value === "string"
                ? parseStoredWidgetValue(w, value)
                : value;
          }
          continue;
        }

        if (value !== undefined && value !== null) {
          const frontendStateKey = buildFrontendStateValueKey({
            nodeId: w.nodeId,
            widget: w.param,
            frontendControlId: w.frontendControlId,
          });
          frontendStateWidgetValues[frontendStateKey] =
            typeof value === "string"
              ? parseStoredWidgetValue(w, value)
              : value;
        }

        const key = `${w.nodeId}:${w.param}`;
        const isRandomized = randomizeToggles[key] ?? false;
        if (w.config.controlAfterGenerate) {
          widgetModes[`widget_mode_${w.nodeId}_${w.param}`] = isRandomized
            ? "randomize"
            : "fixed";
        }
        if (w.config.frontendOnly) {
          continue;
        }

        if (isRandomized && w.config.controlAfterGenerate) {
          continue;
        }
        if (value !== undefined && value !== null) {
          let storedValue: unknown = value;
          if (w.config.valueType === "boolean") {
            if (value === true && w.config.trueValue !== undefined) {
              storedValue = w.config.trueValue;
            } else if (value === false && w.config.falseValue !== undefined) {
              storedValue = w.config.falseValue;
            }
          }
          widgetOverrides[`widget_${w.nodeId}_${w.param}`] =
            String(storedValue);
        }
      }

      await queueGeneration(
        slotValues,
        widgetOverrides,
        widgetModes,
        derivedWidgetInputs,
        count,
        frontendStateWidgetValues,
        [...bypassNodeIds],
        [...activateNodeIds],
      );
    },
    [
      mode,
      queueGeneration,
      workflowInputById,
      workflowInputs,
      textValues,
      randomizeToggles,
    ],
  );

  const handleClearQueue = useCallback(() => {
    void clearGenerationQueue();
  }, [clearGenerationQueue]);

  const handleInterruptCurrent = useCallback(() => {
    void interruptCurrentGeneration();
  }, [interruptCurrentGeneration]);

  const handleUrlSave = useCallback(async () => {
    if (urlInput) {
      try {
        const store = useGenerationStore.getState();
        await store.updateComfyUrl(urlInput);
        store.requestEditorReconnect();
        setUrlAnchorEl(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to update ComfyUI URL";
        window.alert(message);
      }
    }
  }, [urlInput]);

  const handleWorkflowSelect = useCallback(
    (workflowId: string) => {
      setWorkflowLoadState("loading");
      void loadWorkflow(workflowId);
    },
    [loadWorkflow, setWorkflowLoadState],
  );

  const handleWorkflowBack = useCallback(() => {
    clearWorkflowSelection();
  }, [clearWorkflowSelection]);

  const handleDismissWorkflowWarning = useCallback(() => {
    clearWorkflowWarning();
  }, [clearWorkflowWarning]);

  const handleRetryWorkflow = useCallback(() => {
    clearWorkflowLoadError();
    void refreshRuntimeStatus();

    if (selectedWorkflowId) {
      setWorkflowLoadState("loading");
      void loadWorkflow(selectedWorkflowId);
      return;
    }

    void fetchWorkflows();
  }, [
    clearWorkflowLoadError,
    fetchWorkflows,
    loadWorkflow,
    refreshRuntimeStatus,
    selectedWorkflowId,
    setWorkflowLoadState,
  ]);

  const handleOpenEditorFromWarning = useCallback(() => {
    clearWorkflowWarning();
    setEditorOpen(true);
  }, [clearWorkflowWarning, setEditorOpen]);

  const assignAssetToInput = useCallback(
    (inputId: string, asset: Asset) => {
      const requestId =
        (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
      selectionExtractionRequestIdsRef.current[inputId] = requestId;

      if (
        resolveWorkflowInputForSlot(inputId, workflowInputById)?.inputType ===
        "audio"
      ) {
        void fillAudioSlotWithAsset({
          inputId,
          asset,
          extractionRequestId: requestId,
          setMediaInputAsset,
          // The slot id alone is not enough: a value can also be moved to
          // another slot by a reorder, which leaves this request writing into
          // a slot it no longer owns.
          isCurrentRequest: () =>
            selectionExtractionRequestIdsRef.current[inputId] === requestId &&
            isAssetSlotExtractionCurrent(
              readWorkflowInputSlotValue(
                useGenerationStore.getState().mediaInputs,
                inputId,
                workflowInputById,
              ),
              asset.id,
              requestId,
            ),
        });
        return;
      }

      setMediaInputAsset(inputId, asset);
    },
    [setMediaInputAsset, workflowInputById],
  );

  const handleInputDrop = useCallback(
    (inputId: string, asset: Asset) => {
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      if (input?.inputType === "image" && resolveAssetType(asset) === "video") {
        void openDroppedVideoFrameExtraction({
          inputId,
          title: asset.name,
          setMediaInputFrame,
          prepare: async () => {
            const file = await resolveAssetFileForGeneration(asset);
            const sourceUrl = URL.createObjectURL(file);
            try {
              const durationTicks =
                typeof asset.duration === "number" && asset.duration > 0
                  ? mediaSecondsToTick(asset.duration)
                  : await probeVideoDurationTicks(sourceUrl);
              return { sourceUrl, sourceFile: file, durationTicks };
            } catch (error) {
              URL.revokeObjectURL(sourceUrl);
              throw error;
            }
          },
        });
        return;
      }
      assignAssetToInput(inputId, asset);
    },
    [assignAssetToInput, setMediaInputFrame, workflowInputById],
  );

  const handleExternalInputDrop = useCallback(
    async (inputId: string, file: File) => {
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      const isVideoFile =
        file.type.startsWith("video/") || /\.(mp4|mov|mkv)$/i.test(file.name);
      if (input?.inputType === "image" && isVideoFile) {
        await openDroppedVideoFrameExtraction({
          inputId,
          title: file.name,
          setMediaInputFrame,
          prepare: async () => {
            const sourceUrl = URL.createObjectURL(file);
            try {
              const durationTicks = await probeVideoDurationTicks(sourceUrl);
              return { sourceUrl, sourceFile: file, durationTicks };
            } catch (error) {
              URL.revokeObjectURL(sourceUrl);
              throw error;
            }
          },
        });
        return;
      }

      const requestId =
        (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
      selectionExtractionRequestIdsRef.current[inputId] = requestId;

      const ingestedAsset = await addLocalAsset(file, { source: "uploaded" });
      const asset =
        ingestedAsset ??
        (await resolveExistingAssetForExternalDrop(
          file,
          useAssetStore.getState().assets,
        ));
      if (selectionExtractionRequestIdsRef.current[inputId] !== requestId) {
        return;
      }
      if (!asset) {
        return;
      }

      assignAssetToInput(inputId, asset);
    },
    [assignAssetToInput, setMediaInputFrame, workflowInputById],
  );

  /**
   * Restarts a timeline-selection render at the slot the value now occupies.
   * The caller has already invalidated the request the value arrived with, so
   * whatever is still running for it will be discarded on completion.
   */
  const restartSelectionExtraction = useCallback(
    (
      inputId: string,
      value: Extract<GenerationMediaInputValue, { kind: "timelineSelection" }>,
    ) => {
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      const extractionRequestId =
        (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
      selectionExtractionRequestIdsRef.current[inputId] = extractionRequestId;
      const { timelineSelection, thumbnailFile } = value;

      setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
        mediaType: value.mediaType,
        isExtracting: true,
        extractionRequestId,
      });

      if (value.mediaType === "audio") {
        void extractAudioTimelineSelection({
          inputId,
          timelineSelection,
          thumbnailFile,
          extractionRequestId,
          exportFps:
            resolveSelectionConfigFps(
              input?.dispatch?.selectionConfig,
              Math.max(1, useProjectStore.getState().config.fps),
            ) ?? undefined,
          setMediaInputTimelineSelection,
          selectionExtractionRequestIdsRef,
        }).catch((error) => {
          console.error(
            "Failed to restart generation audio timeline selection",
            error,
          );
        });
        return;
      }

      void extractVideoTimelineSelection({
        inputId,
        inputNodeId: input?.nodeId,
        timelineSelection,
        thumbnailFile,
        extractionRequestId,
        mode,
        derivedMaskMappings: useGenerationStore.getState().derivedMaskMappings,
        setMediaInputTimelineSelection,
        selectionExtractionRequestIdsRef,
      }).catch((error) => {
        console.error(
          "Failed to restart generation video timeline selection",
          error,
        );
      });
    },
    [mode, setMediaInputTimelineSelection, workflowInputById],
  );

  /**
   * Moving a value between slots orphans any extraction still running for it:
   * the in-flight request belongs to the slot it started in, so its result is
   * discarded, and the value would sit at its destination marked extracting
   * forever. Restart extraction wherever a pending value came to rest —
   * dropped assets and timeline selections alike, since a stranded selection
   * render leaves the value pending and generation waits on it.
   */
  const restartPendingExtractions = useCallback(
    (inputIds: readonly string[]) => {
      const { mediaInputs } = useGenerationStore.getState();
      const readSlot = (inputId: string) =>
        readWorkflowInputSlotValue(mediaInputs, inputId, workflowInputById);

      for (const { inputId, asset } of collectStalledAudioExtractions(
        inputIds,
        readSlot,
      )) {
        assignAssetToInput(inputId, asset);
      }
      for (const { inputId, value } of collectStalledSelectionExtractions(
        inputIds,
        readSlot,
      )) {
        restartSelectionExtraction(inputId, value);
      }
    },
    [assignAssetToInput, restartSelectionExtraction, workflowInputById],
  );

  /** Every slot id a repeatable input can occupy, including its base slot. */
  const resolveSiblingSlotIds = useCallback(
    (inputId: string) => {
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      const repeatableMax = input?.presentation?.repeatable?.max;
      if (!input || !repeatableMax) {
        return [inputId];
      }
      return Array.from({ length: repeatableMax }, (_, index) =>
        buildRepeatableInputSlotId(input, index),
      );
    },
    [workflowInputById],
  );

  /**
   * Runs a slot edit and repairs the extractions it disturbed.
   *
   * An in-flight extraction belongs to the slot it started in, so any slot the
   * edit rewrites must have its request invalidated — otherwise a render that
   * finishes afterwards writes into a slot it no longer owns, resurrecting a
   * cleared item or duplicating a moved one. The slots that actually changed
   * are compared rather than assumed, so an untouched item still extracting in
   * the same batch is not thrown away and re-rendered for nothing. Everything
   * here is synchronous, so no completion can interleave between the edit and
   * the invalidation.
   */
  const applySlotMutation = useCallback(
    (candidateSlotIds: readonly string[], mutate: () => void) => {
      const slotIds = [...new Set(candidateSlotIds)];
      const readSlots = () => {
        const { mediaInputs } = useGenerationStore.getState();
        return slotIds.map((slotId) =>
          readWorkflowInputSlotValue(mediaInputs, slotId, workflowInputById),
        );
      };

      const before = readSlots();
      mutate();
      const after = readSlots();

      const changedSlotIds = pickChangedSlotIds(slotIds, before, after);
      if (changedSlotIds.length === 0) return;

      bumpSlotExtractionRequestIds(
        selectionExtractionRequestIdsRef.current,
        changedSlotIds,
      );
      restartPendingExtractions(changedSlotIds);
    },
    [restartPendingExtractions, workflowInputById],
  );

  const handleInputClear = useCallback(
    (inputId: string) => {
      // Clearing a repeatable slot shifts every later one down, so the whole
      // batch is in play, not just the slot being cleared.
      applySlotMutation(resolveSiblingSlotIds(inputId), () =>
        clearMediaInput(inputId),
      );
    },
    [applySlotMutation, clearMediaInput, resolveSiblingSlotIds],
  );

  const handleSwapMediaInputs = useCallback(
    (sourceInputId: string, targetInputId: string) => {
      if (sourceInputId === targetInputId) {
        return;
      }

      // A value leaving a batch front-packs what is left behind, so both
      // inputs' slots can shift, not only the two being swapped.
      applySlotMutation(
        [
          ...resolveSiblingSlotIds(sourceInputId),
          ...resolveSiblingSlotIds(targetInputId),
        ],
        () => reassignMediaInput(sourceInputId, targetInputId),
      );
    },
    [applySlotMutation, reassignMediaInput, resolveSiblingSlotIds],
  );

  const handleMoveMediaInput = useCallback(
    (sourceInputId: string, targetIndex: number) => {
      // A move shifts every slot between source and destination.
      applySlotMutation(resolveSiblingSlotIds(sourceInputId), () =>
        moveMediaInput(sourceInputId, targetIndex),
      );
    },
    [applySlotMutation, moveMediaInput, resolveSiblingSlotIds],
  );

  const handleToggleMediaInputOption = useCallback(
    (inputId: string, option: WorkflowInputItemOption, active: boolean) => {
      setMediaInputItemOption(inputId, option, active);
    },
    [setMediaInputItemOption],
  );

  const handleClickSelect = useCallback(
    (inputId: string, inputType: "image" | "video" | "audio") => {
      const extractStore = useExtractStore.getState();
      const timelineSelectionStore = useTimelineSelectionStore.getState();
      const playerStore = usePlayerStore.getState();
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      const selectionConfig =
        input?.dispatch && "selectionConfig" in input.dispatch
          ? input.dispatch.selectionConfig
          : undefined;

      if (playerStore.isPlaying) {
        playerStore.setIsPlaying(false);
      }

      if (inputType === "image") {
        timelineSelectionStore.clearSelectionRecommendations();
        extractStore.enterFrameSelectionMode();
        extractStore.setOnConfirmSelection(() => {
          void (async () => {
            const selectedTick = playbackClock.time;
            const closeFrameSelection = () => {
              const current = useExtractStore.getState();
              current.exitFrameSelectionMode();
              current.setOnConfirmSelection(null);
              useTimelineSelectionStore
                .getState()
                .clearSelectionRecommendations();
            };

            closeFrameSelection();

            try {
              const frameFile = await captureFramePngAtTick(
                selectedTick,
                "generation-frame",
              );
              setMediaInputFrameWithSelection(
                inputId,
                frameFile,
                createPointTimelineSelection(selectedTick),
              );
            } catch (error) {
              console.error("Failed to capture generation image frame", error);
            }
          })();
        });
        return;
      }

      const projectFps = Math.max(1, useProjectStore.getState().config.fps);
      const recommendedFps = resolveSelectionConfigFps(
        selectionConfig,
        projectFps,
      );
      const recommendedFrameStep =
        typeof selectionConfig?.frameStep === "number" &&
        selectionConfig.frameStep > 0
          ? selectionConfig.frameStep
          : null;
      const recommendedFrameOffset =
        typeof selectionConfig?.frameOffset === "number" &&
        selectionConfig.frameOffset > 0
          ? selectionConfig.frameOffset
          : null;
      const recommendedMaxTicks =
        typeof selectionConfig?.maxFrames === "number" &&
        selectionConfig.maxFrames > 0
          ? frameToTick(selectionConfig.maxFrames, recommendedFps ?? projectFps)
          : null;
      timelineSelectionStore.setSelectionFpsOverride(recommendedFps);
      timelineSelectionStore.setSelectionFrameStep(recommendedFrameStep ?? 1);
      timelineSelectionStore.setSelectionFrameOffset(
        recommendedFrameOffset ?? 1,
      );
      // The dispatch's own target resolution, offered as the selection's
      // default: rendering the source at the size the workflow will use skips
      // a resample inside ComfyUI and the upload of pixels it discards. It is
      // a recommendation, not a decision — the selection's own setting wins.
      //
      // Gated on the workflow actually declaring a `target_resolution`
      // control, which is the same condition that decides whether the value is
      // sent at all (`buildPipelineInputs`). A workflow that does no
      // resolution processing has nothing to recommend, and would otherwise
      // push the panel's own default onto every selection.
      const generationState = useGenerationStore.getState();
      const workflowUsesTargetResolution = Boolean(
        getWorkflowStageControl(
          getAspectRatioStage(generationState.activeWorkflowRules),
          "target_resolution",
        ),
      );
      const recommendedResolution = workflowUsesTargetResolution
        ? generationState.targetResolution
        : null;
      timelineSelectionStore.setSelectionRecommendations({
        fps: recommendedFps,
        resolution: recommendedResolution,
        frameStep: recommendedFrameStep,
        frameOffset: recommendedFrameOffset,
        maxTicks: recommendedMaxTicks,
      });

      const selectionStartTick = playbackClock.time;
      const selectionEndTick = getDefaultSelectionEnd(selectionStartTick);

      timelineSelectionStore.enterSelectionMode(
        selectionStartTick,
        selectionEndTick,
        {
          message: selectionConfig?.message ?? null,
          includeTracks: selectionConfig?.includeTracks === true,
        },
      );
      extractStore.setOnConfirmSelection(() => {
        void (async () => {
          let selectionClosed = false;
          const closeSelectionMode = () => {
            if (selectionClosed) return;
            selectionClosed = true;
            useTimelineSelectionStore.getState().exitSelectionMode();
            useExtractStore.getState().setOnConfirmSelection(null);
          };

          try {
            const { selectionStartTick, selectionEndTick } =
              useTimelineSelectionStore.getState();
            const timelineSelection = applySelectionConfigDefaults(
              createTimelineSelection(selectionStartTick, selectionEndTick),
              selectionConfig,
            );
            closeSelectionMode();
            const thumbnailFile =
              inputType === "audio"
                ? createAudioSelectionPlaceholderFile()
                : await captureFramePngAtTick(
                    selectionStartTick,
                    "generation-selection-thumb",
                    timelineSelection,
                  );
            const extractionRequestId =
              (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
            selectionExtractionRequestIdsRef.current[inputId] =
              extractionRequestId;

            setMediaInputTimelineSelection(
              inputId,
              timelineSelection,
              thumbnailFile,
              {
                mediaType: inputType === "audio" ? "audio" : "video",
                isExtracting: true,
                extractionRequestId,
              },
            );

            if (inputType === "audio") {
              await extractAudioTimelineSelection({
                inputId,
                timelineSelection,
                thumbnailFile,
                extractionRequestId,
                exportFps: recommendedFps ?? undefined,
                setMediaInputTimelineSelection,
                selectionExtractionRequestIdsRef,
              });
              return;
            }

            await extractVideoTimelineSelection({
              inputId,
              inputNodeId: input?.nodeId,
              timelineSelection,
              thumbnailFile,
              extractionRequestId,
              mode,
              derivedMaskMappings,
              setMediaInputTimelineSelection,
              selectionExtractionRequestIdsRef,
            });
          } catch (error) {
            const extractionRequestId =
              selectionExtractionRequestIdsRef.current[inputId] ?? 0;
            const storeMediaInputs = useGenerationStore.getState().mediaInputs;
            const existingValue = storeMediaInputs[inputId];
            if (
              existingValue?.kind === "timelineSelection" &&
              existingValue.extractionRequestId === extractionRequestId
            ) {
              setMediaInputTimelineSelection(
                inputId,
                existingValue.timelineSelection,
                existingValue.thumbnailFile,
                {
                  mediaType: existingValue.mediaType,
                  isExtracting: false,
                  extractionRequestId,
                  extractionError:
                    error instanceof Error
                      ? error.message
                      : "Failed to extract timeline selection",
                },
              );
            }
            console.error(
              "Failed to capture generation video timeline selection",
              error,
            );
          } finally {
            closeSelectionMode();
          }
        })();
      });
    },
    [
      derivedMaskMappings,
      mode,
      setMediaInputFrameWithSelection,
      setMediaInputTimelineSelection,
      workflowInputById,
    ],
  );

  const handleEditMedia = useCallback(
    (inputId: string, inputType: "video") => {
      if (inputType !== "video") return;
      const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
      const currentMediaInputs = useGenerationStore.getState().mediaInputs;
      const value = input
        ? getWorkflowInputSlotValue(
            currentMediaInputs,
            input,
            parseRepeatableInputSlotId(inputId)?.index ?? 0,
            workflowInputById,
          )
        : currentMediaInputs[inputId];
      if (!value) return;

      if (usePlayerStore.getState().isPlaying) {
        usePlayerStore.getState().setIsPlaying(false);
      }

      // Resolve the editable source. When the input is a timeline selection,
      // the edit rebuilds a real selection (crop + range_mask components) that
      // re-renders through the normal pipeline; `sourceSelection` carries it
      // through to onSave. A plain asset has no backing timeline, so it falls
      // back to a synthetic single-clip bake.
      let sourceSelection: TimelineSelection | null = null;
      let prepare: () => Promise<ResolvedEditorSource>;

      if (value.kind === "asset" && value.asset.type === "video") {
        const asset = value.asset;
        prepare = async () => {
          const file = await resolveAssetFileForGeneration(asset);
          const videoUrl = URL.createObjectURL(file);
          const durationTicks =
            typeof asset.duration === "number" && asset.duration > 0
              ? mediaSecondsToTick(asset.duration)
              : await probeVideoDurationTicks(videoUrl);
          return { sourceUrl: videoUrl, sourceFile: file, durationTicks };
        };
      } else if (
        value.kind === "timelineSelection" &&
        value.mediaType === "video"
      ) {
        const selection = value.timelineSelection;
        const existingPrepared = value.preparedVideoFile;
        sourceSelection = selection;
        prepare = async () => {
          const file =
            existingPrepared ?? (await renderTimelineSelectionToMp4(selection));
          const videoUrl = URL.createObjectURL(file);
          const durationTicks =
            typeof selection.end === "number"
              ? Math.max(0, selection.end - selection.start)
              : await probeVideoDurationTicks(videoUrl);
          return { sourceUrl: videoUrl, sourceFile: file, durationTicks };
        };
      } else {
        return;
      }

      const onSave = async (
        spec: MiniEditorEditSpec,
        source: ResolvedEditorSource,
      ) => {
        const thumbnailFile = await captureVideoFrameFile(
          source.sourceUrl,
          tickToMediaSeconds(spec.cropStartTicks),
          `mini-editor-thumb-${Date.now()}.png`,
        );
        const extractionRequestId =
          (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
        selectionExtractionRequestIdsRef.current[inputId] = extractionRequestId;

        // Timeline-selection inputs: build a true edited selection and render
        // it through the standard extraction path so timeline masks, transforms
        // and metadata are preserved and the derived mask is recomputed.
        if (sourceSelection) {
          const editedSelection = buildEditedTimelineSelection(
            sourceSelection,
            spec,
          );
          setMediaInputTimelineSelection(
            inputId,
            editedSelection,
            thumbnailFile,
            {
              mediaType: "video",
              isExtracting: true,
              extractionRequestId,
            },
          );
          await extractVideoTimelineSelection({
            inputId,
            inputNodeId: input?.nodeId,
            timelineSelection: editedSelection,
            thumbnailFile,
            extractionRequestId,
            mode,
            derivedMaskMappings,
            setMediaInputTimelineSelection,
            selectionExtractionRequestIdsRef,
          });
          return;
        }

        // Plain asset inputs: no backing timeline, so bake a synthetic clip.
        const { sourceWidth, sourceHeight } = useMiniEditorStore.getState();
        const dims = {
          width: sourceWidth > 0 ? sourceWidth : 1280,
          height: sourceHeight > 0 ? sourceHeight : 720,
        };
        const { video, mask } = await renderSyntheticEditedOutputs(
          spec,
          source,
          dims,
        );
        const cropLen = Math.max(1, spec.cropEndTicks - spec.cropStartTicks);

        setMediaInputTimelineSelection(
          inputId,
          { start: 0, end: cropLen, clips: [] },
          thumbnailFile,
          {
            mediaType: "video",
            isExtracting: false,
            extractionRequestId,
            preparedVideoFile: video,
            preparedMaskFile: mask,
          },
        );
      };

      // Inherit the workflow's frame-step constraint so the crop is stepped:
      // from the selection itself when present, else the input's selection rule.
      const projectFps = Math.max(1, useProjectStore.getState().config.fps);
      const selectionConfig =
        input?.dispatch && "selectionConfig" in input.dispatch
          ? input.dispatch.selectionConfig
          : undefined;
      const constraintFps = sourceSelection
        ? sourceSelection.fps && sourceSelection.fps > 0
          ? sourceSelection.fps
          : projectFps
        : (resolveSelectionConfigFps(selectionConfig, projectFps) ?? projectFps);
      const constraintFrameStep = resolveGridConstraint(
        sourceSelection?.frameStep,
        selectionConfig?.frameStep,
      );
      const constraintFrameOffset = resolveGridConstraint(
        sourceSelection?.frameOffset,
        selectionConfig?.frameOffset,
      );

      void useMiniEditorStore.getState().open({
        openerId: "generation-panel",
        title: input?.label ? `Edit: ${input.label}` : "Edit video",
        prepare,
        onSave,
        frameConstraint: {
          fps: constraintFps,
          frameStep: constraintFrameStep,
          frameOffset: constraintFrameOffset,
        },
      });
    },
    [
      derivedMaskMappings,
      mode,
      setMediaInputTimelineSelection,
      workflowInputById,
    ],
  );

  const handleTextValuesCommit = useCallback(
    (updates: ReadonlyMap<string, string>) => {
      clearPendingReplayPanelState();
      setTextValues((prev) => {
        let next = prev;
        for (const [inputId, value] of updates) {
          const canonicalInputId =
            resolveWorkflowInputKeys(inputId, workflowInputById)[0] ?? inputId;
          if (next[canonicalInputId] === value) continue;
          if (next === prev) next = { ...prev };
          next[canonicalInputId] = value;
        }
        return next;
      });
    },
    [clearPendingReplayPanelState, workflowInputById],
  );

  const handleWidgetChange = useCallback(
    (nodeId: string, param: string, value: unknown) => {
      clearPendingReplayPanelState();
      const key = getNodeBypassWidgetKey(nodeId, param);
      if (bypassedWidgetTargetsRef.current.has(key)) {
        const next = new Set(bypassedWidgetTargetsRef.current);
        next.delete(key);
        bypassedWidgetTargetsRef.current = next;
        setBypassedWidgetTargets(next);
      }
      widgetValuesRef.current = setNodeParamValue(
        widgetValuesRef.current,
        nodeId,
        param,
        value,
      );
      setWidgetValues((prev) => {
        if (Object.is(prev[nodeId]?.[param], value)) {
          return prev;
        }
        return setNodeParamValue(prev, nodeId, param, value);
      });
    },
    [clearPendingReplayPanelState],
  );

  const handleWidgetBypassChoice = useCallback(
    (nodeId: string, param: string, value: unknown): boolean => {
      const widget = widgetInputsRef.current.find(
        (candidate) =>
          candidate.nodeId === nodeId && candidate.param === param,
      );
      if (!widget || !isNodeBypassWidgetValue(widget, value)) {
        return false;
      }

      clearPendingReplayPanelState();
      const next = new Set(bypassedWidgetTargetsRef.current);
      next.add(getNodeBypassWidgetKey(nodeId, param));
      bypassedWidgetTargetsRef.current = next;
      setBypassedWidgetTargets(next);
      return true;
    },
    [clearPendingReplayPanelState],
  );

  const handleToggleRandomize = useCallback(
    (nodeId: string, param: string) => {
      clearPendingReplayPanelState();
      const key = `${nodeId}:${param}`;
      setRandomizeToggles((prev) => ({
        ...prev,
        [key]: !prev[key],
      }));
    },
    [clearPendingReplayPanelState],
  );

  const isRunning =
    activeJob?.status === "running" || activeJob?.status === "queued";
  const isPreprocessing = pipelineStatus.phase === "preprocessing";
  const hasQueuedGenerations = queuedGenerationCount > 0;
  const isPostprocessing = postprocessingCount > 0;
  const isPipelineBusy = isPreprocessing || isRunning || hasQueuedGenerations;
  const canInterruptCurrentGeneration = isPreprocessing || isRunning;
  const canClearQueuedGenerations = hasQueuedGenerations;
  const isPipelineInterruptible = isPipelineBusy;
  const queueStatusText = hasQueuedGenerations
    ? `${queuedGenerationCount} queued${isRunning || isPreprocessing ? " after current" : ""}`
    : null;
  const postprocessingStatusText = isPostprocessing
    ? postprocessingCount === 1
      ? "Rendering generation"
      : `Rendering ${postprocessingCount} generations`
    : null;
  const pipelineStatusText = isPreprocessing
    ? pipelineStatus.message
    : [queueStatusText, postprocessingStatusText].filter(Boolean).join(" • ") ||
      null;
  const inputValidationFailures =
    mode === "manual"
      ? []
      : findWorkflowInputValidationFailures(
          workflowInputs,
          activeWorkflowRules,
          providedInputIds,
        );
  const inputValidationSatisfied = inputValidationFailures.length === 0;

  const comfyConnected = runtimeStatus?.comfyui.status === "connected";

  const canGenerate =
    comfyConnected &&
    isWorkflowReady &&
    !isWorkflowLoading &&
    (workflowInputs.length > 0 || widgetInputs.length > 0) &&
    inputValidationSatisfied;

  const connectionChipLabel = runtimeStatusError
    ? "Backend unavailable"
    : runtimeStatus?.comfyui.status === "invalid_config"
      ? "ComfyUI misconfigured"
      : comfyConnected
        ? "ComfyUI connected"
        : connectionStatus === "connecting"
          ? "Checking ComfyUI..."
          : "ComfyUI disconnected";

  const connectionChipColor: ChipProps["color"] =
    runtimeStatusError || runtimeStatus?.comfyui.status === "invalid_config"
      ? "error"
      : comfyConnected
        ? "success"
        : connectionStatus === "connecting"
          ? "default"
          : "warning";

  const connectionSummary = runtimeStatusError
    ? runtimeStatusError
    : (runtimeStatus?.comfyui.error ?? null);
  const comfyuiModelDownloadsEnabled =
    runtimeStatus?.comfyui.modelDownloadsEnabled === true;

  // Resolve imported assets that have a TimelineSelection (eligible for "send to timeline")
  const allAssets = useAssetStore((s) => s.assets);
  const importedAssets = useMemo(() => {
    const ids = displayJob?.importedAssetIds;
    if (!ids || ids.length === 0) return [];
    const assetsById = new Map(allAssets.map((asset) => [asset.id, asset]));
    return ids
      .map((id) => assetsById.get(id))
      .filter((asset): asset is Asset => Boolean(asset));
  }, [displayJob?.importedAssetIds, allAssets]);

  const sendableAssets = useMemo(() => {
    return importedAssets.filter(
      (asset) => getTimelineSelectionFromAsset(asset) !== null,
    );
  }, [importedAssets]);

  const handleSendToTimeline = useCallback(() => {
    for (const asset of sendableAssets) {
      const selection = getTimelineSelectionFromAsset(asset);
      if (selection) {
        insertAssetAtTime(asset, selection.start);
      }
    }
  }, [sendableAssets]);

  return {
    // State
    editorOpen,
    setEditorOpen,
    urlAnchorEl,
    setUrlAnchorEl,
    urlInput,
    setUrlInput,
    textValues,
    handleTextValuesCommit,
    mediaInputs,

    // Widget state
    widgetInputs,
    generationNodes,
    widgetValues,
    bypassedWidgetTargets,
    randomizeToggles,
    handleWidgetChange,
    handleWidgetBypassChoice,
    handleToggleRandomize,

    // Derived
    connectionStatus,
    runtimeStatus,
    runtimeStatusError,
    latestPreviewUrl,
    previewAnimation,
    comfyuiDirectUrl,
    workflowInputs,
    activeJob,
    activeJobId,
    displayJob,
    availableWorkflows,
    selectedWorkflowId,
    isWorkflowLoading,
    isWorkflowReady,
    workflowLoadError,
    workflowWarning,
    hasInferredInputs,
    workflowRuleWarnings,
    inputValidationFailures,
    queuedGenerationCount,
    postprocessingCount,
    isRunning,
    isPipelineBusy,
    canInterruptCurrentGeneration,
    canClearQueuedGenerations,
    isPipelineInterruptible,
    isPostprocessing,
    pipelineStatusText,
    canGenerate,
    connectionChipLabel,
    connectionChipColor,
    connectionSummary,
    comfyuiModelDownloadsEnabled,

    // Send to timeline
    importedAssets,
    sendableAssets,
    handleSendToTimeline,

    // Handlers
    handleGenerate,
    handleInterruptCurrent,
    handleClearQueue,
    handleUrlSave,
    handleWorkflowSelect,
    handleWorkflowBack,
    handleRetryWorkflow,
    handleDismissWorkflowWarning,
    handleOpenEditorFromWarning,
    handleInputDrop,
    handleExternalInputDrop,
    handleInputClear,
    handleSwapMediaInputs,
    handleMoveMediaInput,
    handleToggleMediaInputOption,
    handleClickSelect,
    handleEditMedia,
  };
}
