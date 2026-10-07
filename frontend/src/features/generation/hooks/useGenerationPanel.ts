import { projectTimelineSelection } from "../../timeline/time";
import type { GenerationCapturedMedia } from "../utils/capturedMedia";
import { registerGenerationInputCapture, type GenerationCaptureDestination } from "../services/GenerationInputCapture";
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
  getTimelineSelectionStartFromAsset,
  useTimelineSelectionStore,
} from "../../timelineSelection";
import { useGenerationStore } from "../useGenerationStore";
import { useProjectStore } from "../../project";
import type {
  GenerationMediaInputValue,
  GenerationBakedEditOrigin,
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
import { bakeMiniEditorVideo, replayMiniEditorAssetEdit } from "../services/miniEditorReplay";
import { buildDerivedMaskRenderSignature } from "../utils/derivedMaskRenderSignature";
import {
  buildEditedTimelineSelection,
  getTimelineSelectionEditorState,
} from "../utils/miniEditorEdit";
import {
  createAudioSelectionPlaceholderFile,
  extractAudioFromSelection,
  extractAudioFromVideo,
  probeAudioDurationTicks,
  trimAudioFile,
} from "../utils/manualSlotMedia";
import {
  captureVideoFrameFile,
  probeVideoDurationTicks,
} from "../../../core/media";
import { useMiniEditorStore } from "../../miniEditor";
import type {
  ResolvedEditorSource,
  MiniEditorEditSpec,
  MiniEditorFrameConstraint,
  MiniEditorInitialState,
} from "../../miniEditor";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { resolveWidgetInputs } from "../store/workflowState";
import { useMediaInputPreparationStore } from "../store/useMediaInputPreparationStore";
import { parseInputsFromGraphData } from "../services/workflowBridge";
import { parseInputsFromApiWorkflow } from "../services/apiWorkflowInputs";
import { addLocalAsset, getAssets, useAssetStore } from "../../userAssets";
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
  settleFailedSelectionExtraction,
  NO_ASSET_AUDIO_TRACK_MESSAGE,
} from "../utils/audioSlotExtraction";
import { isAudioSlotVideoAsset } from "../utils/audioSlotAssets";
import { readIncludeEmbeddedAudio } from "../utils/mediaInputItemOptions";
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
import { shouldShowHistoricalGenerationJob } from "../utils/panelDisplayJob";
import {
  areWidgetValueMapsEqual,
  hydrateReplayRandomizeToggles,
  hydrateReplayTextValues,
  resolveReplayNodeBypassWidgetTargets,
  resolveReplayWidgetValues,
  shouldWaitForReplayPanelHydration,
} from "../utils/replayPanelHydration";
import {
  collectBypassDiscoveryDiagnostics,
  collectBypassDiscoveryNodeIds,
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../utils/loraLoaderWidgets";
import {
  collectLoraStackDiagnostics,
  collectLoraStackNodeIds,
  packLoraStacks,
  presentLoraStackWidgetInputs,
} from "../utils/loraStacks";
import { collectWidgetSubmissionState } from "../utils/widgetSubmissionState";
import {
  createReplayPanelCarry,
  takeLateReplayWidgets,
  withPendingReplayCarry,
  type ReplayPanelCarry,
} from "../utils/replayPanelCarry";
import { parseStoredWidgetValue } from "../utils/storedWidgetValues";
import { applyDynamicWidgetBounds } from "../utils/dynamicWidgetBounds";
import type { GenerationPanelValuesSnapshot } from "../persistence/generationPanelSnapshot";
import {
  collectDefaultNodeBypassWidgetTargets,
  getNodeBypassWidgetKey,
  isNodeBypassWidgetValue,
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

/**
 * The crop grid the mini editor has to obey for a slot: the selection's own
 * frame rate when it has one, otherwise the workflow's selection rule, and the
 * project's as the floor. Shared by the video and audio editors so a cropped
 * reference of either kind lands on the same frames.
 */
function resolveEditorFrameConstraint(
  sourceSelection: TimelineSelection | null,
  selectionConfig: WorkflowSelectionConfig | undefined,
): MiniEditorFrameConstraint {
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);
  return {
    fps: sourceSelection
      ? sourceSelection.fps && sourceSelection.fps > 0
        ? sourceSelection.fps
        : projectFps
      : (resolveSelectionConfigFps(selectionConfig, projectFps) ?? projectFps),
    frameStep: resolveGridConstraint(
      sourceSelection?.frameStep,
      selectionConfig?.frameStep,
    ),
    frameOffset: resolveGridConstraint(
      sourceSelection?.frameOffset,
      selectionConfig?.frameOffset,
    ),
  };
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

/**
 * Marks a slot busy for the whole of a click-to-select flow — the render that
 * produces the value included, which happens before there is any value to hang
 * `isExtracting` on. Always paired with {@link endMediaInputPreparation} in a
 * `finally`, or the slot would spin forever after a failure.
 */
function beginMediaInputPreparation(inputId: string): void {
  useMediaInputPreparationStore.getState().beginMediaInputPreparation(inputId);
}

function endMediaInputPreparation(inputId: string): void {
  useMediaInputPreparationStore.getState().endMediaInputPreparation(inputId);
}

/**
 * How long a queued replay state waits for inputs that a settled workflow has
 * not produced. Long enough to cover the gap between one load finishing and
 * the next starting — the ComfyUI editor registering, a bridge retry — and
 * short enough that a workflow which simply has no such inputs stops holding
 * the project's panel state back from being saved.
 */
const REPLAY_PANEL_HYDRATION_GRACE_MS = 5_000;

const NO_SELECTION_AUDIO_TRACK_MESSAGE =
  "No audio track was found in the selected timeline range";

/**
 * The slot's current value and the workflow input backing it, resolved the
 * same way whichever media editor is being opened.
 */
function readSlotValueForEdit(
  inputId: string,
  workflowInputById: ReadonlyMap<string, WorkflowInput>,
): {
  input: WorkflowInput | undefined;
  value: GenerationMediaInputValue | null | undefined;
} {
  const input = resolveWorkflowInputForSlot(inputId, workflowInputById);
  const currentMediaInputs = useGenerationStore.getState().mediaInputs;
  return {
    input,
    value: input
      ? getWorkflowInputSlotValue(
          currentMediaInputs,
          input,
          parseRepeatableInputSlotId(inputId)?.index ?? 0,
          workflowInputById,
        )
      : currentMediaInputs[inputId],
  };
}

/** Frame rate an audio selection re-renders at when it carries none itself. */
function resolveEditAudioExportFps(
  input: WorkflowInput | undefined,
): number | undefined {
  return (
    resolveSelectionConfigFps(
      input?.dispatch?.selectionConfig,
      Math.max(1, useProjectStore.getState().config.fps),
    ) ?? undefined
  );
}

interface AudioSelectionExtractionOptions {
  inputId: string;
  timelineSelection: ReturnType<typeof createTimelineSelection>;
  bakedEdit?: GenerationBakedEditOrigin;
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
  bakedEdit,
  thumbnailFile,
  extractionRequestId,
  exportFps,
  setMediaInputTimelineSelection,
  selectionExtractionRequestIdsRef,
}: AudioSelectionExtractionOptions): Promise<void> {
  const isCurrent = () =>
    selectionExtractionRequestIdsRef.current[inputId] === extractionRequestId;

  let preparedAudioFile: File | null;
  try {
    preparedAudioFile = await extractAudioFromSelection(timelineSelection, {
      exportFps,
    });
  } catch (error) {
    settleFailedSelectionExtraction(
      {
        inputId,
        timelineSelection,
        thumbnailFile,
        extractionRequestId,
        mediaType: "audio",
        fallbackMessage:
          "Failed to extract audio from the selected timeline range",
        setMediaInputTimelineSelection,
        selectionExtractionRequestIdsRef,
      },
      error,
    );
    throw error;
  }

  if (!isCurrent()) return;
  setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
    mediaType: "audio",
    bakedEdit,
    isExtracting: false,
    extractionRequestId,
    preparedAudioFile,
    extractionError:
      preparedAudioFile === null ? NO_SELECTION_AUDIO_TRACK_MESSAGE : null,
  });
}

interface VideoSelectionExtractionOptions {
  inputId: string;
  inputNodeId?: string;
  timelineSelection: ReturnType<typeof createTimelineSelection>;
  bakedEdit?: GenerationBakedEditOrigin;
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
  bakedEdit,
  thumbnailFile,
  extractionRequestId,
  mode,
  derivedMaskMappings,
  setMediaInputTimelineSelection,
  selectionExtractionRequestIdsRef,
}: VideoSelectionExtractionOptions): Promise<void> {
  const isCurrent = () =>
    selectionExtractionRequestIdsRef.current[inputId] === extractionRequestId;

  try {
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
      const { video, masks } =
        await renderTimelineSelectionToMp4WithDerivedMasks(
          timelineSelection,
          cachedVisualMasks,
        );
      if (!isCurrent()) return;
      setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
        mediaType: "video",
        bakedEdit,
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
    if (!isCurrent()) return;
    setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
      mediaType: "video",
      bakedEdit,
      isExtracting: false,
      extractionRequestId,
      preparedVideoFile,
    });
  } catch (error) {
    settleFailedSelectionExtraction(
      {
        inputId,
        timelineSelection,
        thumbnailFile,
        extractionRequestId,
        mediaType: "video",
        fallbackMessage: "Failed to render the selected timeline range",
        setMediaInputTimelineSelection,
        selectionExtractionRequestIdsRef,
      },
      error,
    );
    throw error;
  }
}

export function useGenerationPanel(mode: "rules" | "manual" = "rules") {
  const editorOpen = useGenerationStore((s) => s.editorOpen);
  const setEditorOpen = useGenerationStore((s) => s.setEditorOpen);
  const [urlAnchorEl, setUrlAnchorEl] = useState<null | HTMLElement>(null);
  const [urlInput, setUrlInput] = useState("");

  // Slot values keyed by workflow input ID
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const previousTextWorkflowInputsRef = useRef<WorkflowInput[]>([]);
  /** The workflow those inputs came from; node ids only mean identity within one. */
  const previousTextWorkflowSourceIdRef = useRef<string | null>(null);

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
  /** Whether each bypassable loader's node shipped bypassed when last seen. */
  const shippedBypassRef = useRef<ReadonlyMap<string, boolean>>(new Map());
  const randomizeTogglesRef = useRef<Record<string, boolean>>({});
  /** The workflow the panel's widget values were last reconciled against. */
  const widgetValuesWorkflowRef = useRef<string | null>(null);
  const replayCarryRef = useRef<ReplayPanelCarry | null>(null);

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
  const pendingPanelSnapshot = useGenerationStore(
    (s) => s.pendingPanelSnapshot,
  );
  const isRestoringPanelSnapshot = useGenerationStore(
    (s) => s.isRestoringPanelSnapshot,
  );
  const panelSnapshotRestoreFailed = useGenerationStore(
    (s) => s.panelSnapshotRestoreFailed,
  );
  const panelResetToken = useGenerationStore((s) => s.panelResetToken);
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
  // Stack members are opted in by membership alone. They stay out of the
  // opt-in diagnostics, which would call an active member ineffective.
  const loraDiscoveryNodeIds = useMemo(() => {
    const stackNodeIds = collectLoraStackNodeIds(activeWorkflowRules);
    return stackNodeIds.size === 0
      ? bypassDiscoveryNodeIds
      : new Set([...bypassDiscoveryNodeIds, ...stackNodeIds]);
  }, [activeWorkflowRules, bypassDiscoveryNodeIds]);
  const autodiscoveredLoraWidgetInputs = useMemo(
    () =>
      resolveAutodiscoveredLoraWidgetInputs(
        generationNodes,
        loraDiscoveryNodeIds,
      ),
    [generationNodes, loraDiscoveryNodeIds],
  );
  // An ineffective discovery opt-in or stack member is advisory, like other
  // rule warnings.
  useEffect(() => {
    for (const diagnostic of [
      ...collectBypassDiscoveryDiagnostics(
        generationNodes,
        bypassDiscoveryNodeIds,
      ),
      ...collectLoraStackDiagnostics(generationNodes, activeWorkflowRules),
    ]) {
      console.debug("[GenerationPanel] Workflow rule warning", {
        workflowId: selectedWorkflowId,
        message: diagnostic,
      });
    }
  }, [
    activeWorkflowRules,
    bypassDiscoveryNodeIds,
    generationNodes,
    selectedWorkflowId,
  ]);
  const authoredWidgetInputs = useMemo(
    () =>
      mergeAutodiscoveredLoraWidgetInputs(
        baseWidgetInputs,
        autodiscoveredLoraWidgetInputs,
      ),
    [autodiscoveredLoraWidgetInputs, baseWidgetInputs],
  );
  // Bounds a rule tied to another widget (a sampling window against the step
  // count) are resolved here, where the panel's live values are: the resolver
  // only ever sees the workflow's own values.
  const boundedWidgetInputs = useMemo(
    () =>
      applyDynamicWidgetBounds({
        widgetInputs: authoredWidgetInputs,
        widgetValues,
      }),
    [authoredWidgetInputs, widgetValues],
  );
  const widgetInputs = boundedWidgetInputs.widgetInputs;
  // What the panel draws. Reconciliation and submission keep reading
  // `widgetInputs`, so presentation cannot change what a generation sends.
  const presentedWidgetInputs = useMemo(
    () =>
      presentLoraStackWidgetInputs(
        widgetInputs,
        activeWorkflowRules,
        bypassedWidgetTargets,
      ),
    [activeWorkflowRules, bypassedWidgetTargets, widgetInputs],
  );

  // A bound that moved under a value out of range pulls it back in, so the
  // panel never submits a window past the last step the sampler runs.
  useEffect(() => {
    const clamped = boundedWidgetInputs.clamped;
    if (clamped.length === 0) return;
    let next = widgetValuesRef.current;
    for (const entry of clamped) {
      if (Object.is(next[entry.nodeId]?.[entry.param], entry.value)) continue;
      next = setNodeParamValue(next, entry.nodeId, entry.param, entry.value);
    }
    if (next === widgetValuesRef.current) return;
    widgetValuesRef.current = next;
    setWidgetValues(next);
  }, [boundedWidgetInputs]);

  useEffect(() => {
    widgetInputsRef.current = widgetInputs;
  }, [widgetInputs]);

  useEffect(() => {
    if (bypassWorkflowSourceRef.current === selectedWorkflowId) return;
    bypassWorkflowSourceRef.current = selectedWorkflowId;
    // A new workflow gets its rule defaults applied afresh.
    appliedBypassDefaultsRef.current = new Set();
    shippedBypassRef.current = new Map();
    if (replayCarryRef.current?.workflowId !== selectedWorkflowId) {
      replayCarryRef.current = null;
    }
    const next = new Set<string>();
    bypassedWidgetTargetsRef.current = next;
    setBypassedWidgetTargets(next);
  }, [selectedWorkflowId]);

  // A reload of the workflow already on screen clears its graph until the
  // reload lands, so its widgets drop out and come back. They are the same
  // widgets, and what the panel holds for them has to survive the gap.
  // Switching workflow also loads, but the values are the outgoing
  // workflow's, and those are let go as before.
  // Called from effects only: it reads a ref.
  const isReloadingSameWorkflow = () =>
    isWorkflowLoading &&
    selectedWorkflowId !== null &&
    widgetValuesWorkflowRef.current === selectedWorkflowId;

  useEffect(() => {
    const reconciliation = reconcileNodeBypassWidgetTargets({
      widgetInputs,
      previousTargets: bypassedWidgetTargetsRef.current,
      appliedDefaults: appliedBypassDefaultsRef.current,
      previousShippedBypass: shippedBypassRef.current,
      preserveMissing: isReloadingSameWorkflow(),
    });
    appliedBypassDefaultsRef.current = reconciliation.appliedDefaults;
    shippedBypassRef.current = reconciliation.shippedBypass;
    if (!reconciliation.changed) return;
    bypassedWidgetTargetsRef.current = reconciliation.targets;
    setBypassedWidgetTargets(reconciliation.targets);
    // Only re-run when widgetInputs identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetInputs]);

  useEffect(() => {
    widgetValuesRef.current = widgetValues;
  }, [widgetValues]);

  useEffect(() => {
    randomizeTogglesRef.current = randomizeToggles;
  }, [randomizeToggles]);

  useEffect(() => {
    // Read the refs once, here, and hand the values to the updater. React runs
    // an updater during the re-render, after this effect body has finished, so
    // an updater that read a ref itself would find what was just written to it
    // — matching the incoming workflow against itself and resolving every
    // value to its default.
    const previousInputs = previousTextWorkflowInputsRef.current;
    const previousSourceId = previousTextWorkflowSourceIdRef.current;
    if (workflowInputs.length > 0) {
      previousTextWorkflowInputsRef.current = workflowInputs;
      previousTextWorkflowSourceIdRef.current = selectedWorkflowId;
    }

    setTextValues((prev) => {
      // Nothing to reconcile against yet. That covers a workflow mid-load and
      // equally a step back to the menu, which is the only way to reach a
      // second workflow — reconciling against no inputs at all would answer
      // "no values", emptying the prompt the next workflow is meant to inherit.
      if (workflowInputs.length === 0) {
        return prev;
      }

      const next = carryOverTextValues(previousInputs, prev, workflowInputs, {
        sameWorkflow: previousSourceId === selectedWorkflowId,
      });
      const changed =
        Object.keys(prev).length !== Object.keys(next).length ||
        Object.entries(next).some(([key, value]) => prev[key] !== value);
      return changed ? next : prev;
    });
  }, [selectedWorkflowId, workflowInputs]);

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
  // changes, initialize newly-added widgets, and drop disappeared ones —
  // except while the same workflow reloads, when every widget disappears.
  //
  // A widget arriving after a replay was hydrated takes the replay's value
  // rather than the workflow's own (see `ReplayPanelCarry`).
  useEffect(() => {
    const reconciliation = reconcileWidgetValues({
      widgetInputs,
      previousValues: widgetValuesRef.current,
      previousCurrentValues: widgetCurrentValuesRef.current,
      preserveMissing: isReloadingSameWorkflow(),
    });
    if (widgetInputs.length > 0) {
      widgetValuesWorkflowRef.current = selectedWorkflowId;
    }

    let nextValues = reconciliation.values;
    let valuesChanged = reconciliation.valuesChanged;
    let lateWidgets: WorkflowWidgetInput[] = [];
    const carry = replayCarryRef.current;
    if (carry && carry.workflowId === selectedWorkflowId) {
      const taken = takeLateReplayWidgets(carry, widgetInputs);
      replayCarryRef.current = taken.carry;
      lateWidgets = taken.widgets;
    }

    if (lateWidgets.length > 0 && carry) {
      const replayedValues = resolveReplayWidgetValues(carry.state, lateWidgets);
      for (const [nodeId, params] of Object.entries(replayedValues ?? {})) {
        for (const [param, value] of Object.entries(params)) {
          if (Object.is(nextValues[nodeId]?.[param], value)) continue;
          nextValues = setNodeParamValue(nextValues, nodeId, param, value);
          valuesChanged = true;
        }
      }

      // The bypass pass has already run for these widgets and given them the
      // rule default; the replayed choice replaces it, and counts as applied
      // so the default is not layered back on later.
      const replayedBypasses = resolveReplayNodeBypassWidgetTargets(
        carry.state,
        lateWidgets,
      );
      const targets = new Set(bypassedWidgetTargetsRef.current);
      const appliedDefaults = new Set(appliedBypassDefaultsRef.current);
      for (const widget of lateWidgets) {
        if (!widget.config.nodeBypassOption) continue;
        const key = getNodeBypassWidgetKey(widget.nodeId, widget.param);
        appliedDefaults.add(key);
        if (replayedBypasses.has(key)) targets.add(key);
        else targets.delete(key);
      }
      appliedBypassDefaultsRef.current = appliedDefaults;
      if (
        targets.size !== bypassedWidgetTargetsRef.current.size ||
        [...targets].some((key) => !bypassedWidgetTargetsRef.current.has(key))
      ) {
        bypassedWidgetTargetsRef.current = targets;
        setBypassedWidgetTargets(targets);
      }
    }

    widgetCurrentValuesRef.current = reconciliation.currentValues;
    if (valuesChanged) {
      widgetValuesRef.current = nextValues;
      setWidgetValues(nextValues);
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
    const lateToggles =
      carry && lateWidgets.length > 0
        ? hydrateReplayRandomizeToggles(nextToggles, carry.state, lateWidgets)
            .value
        : nextToggles;
    setRandomizeToggles((prev) => ({ ...prev, ...lateToggles }));
    // Only re-run when widgetInputs identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetInputs]);

  // Show the value the backend picked for each widget left to randomize, so
  // the seed a generation used can be read off the panel.
  //
  // Only those: the backend reports every widget it applied, and it reports
  // them when a submission lands — which, with generations queued, is well
  // after the panel has moved on. Taking the rest would roll the user's newer
  // edits back to what an older submission carried.
  useEffect(() => {
    let next = widgetValuesRef.current;
    for (const [key, applied] of Object.entries(lastAppliedWidgetValues)) {
      if (randomizeTogglesRef.current[key] !== true) continue;
      const widget = widgetInputsRef.current.find(
        (candidate) => `${candidate.nodeId}:${candidate.param}` === key,
      );
      if (!widget?.config.controlAfterGenerate) continue;
      const value = parseStoredWidgetValue(widget, applied);
      if (Object.is(next[widget.nodeId]?.[widget.param], value)) continue;
      next = setNodeParamValue(next, widget.nodeId, widget.param, value);
    }
    if (next === widgetValuesRef.current) return;
    widgetValuesRef.current = next;
    setWidgetValues(next);
  }, [lastAppliedWidgetValues]);

  // Hydrate panel state from a queued generation-replay snapshot after the
  // workflow/widget inputs are visible. Doing this in an effect keeps React's
  // render phase pure while still restoring saved seed/widget values once.
  useEffect(() => {
    if (!pendingReplayPanelState) {
      return;
    }

    // Not ready yet: the state stays queued rather than being consumed
    // against a panel that has nothing to apply it to. A load in flight will
    // rebuild the inputs and re-run this; once one has settled without them,
    // the state is given a grace period and then dropped, because a queued
    // state also holds back the project's own saves.
    if (
      shouldWaitForReplayPanelHydration(
        pendingReplayPanelState,
        workflowInputs,
        widgetInputs,
      )
    ) {
      if (isWorkflowLoading) {
        return;
      }
      const timer = setTimeout(
        clearPendingReplayPanelState,
        REPLAY_PANEL_HYDRATION_GRACE_MS,
      );
      return () => clearTimeout(timer);
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

    replayCarryRef.current = createReplayPanelCarry(
      selectedWorkflowId,
      pendingReplayPanelState,
      widgetInputs,
    );
    clearPendingReplayPanelState();
  }, [
    clearPendingReplayPanelState,
    isWorkflowLoading,
    pendingReplayPanelState,
    selectedWorkflowId,
    widgetInputs,
    workflowInputs,
  ]);

  // Text and widget values live here rather than in the store, so a project
  // change has to reach in and clear them: nothing else would, and they would
  // otherwise be saved into a project that never entered them.
  const previousPanelResetTokenRef = useRef(panelResetToken);
  useEffect(() => {
    if (previousPanelResetTokenRef.current === panelResetToken) return;
    previousPanelResetTokenRef.current = panelResetToken;

    setTextValues({});
    widgetValuesRef.current = {};
    setWidgetValues({});
    setRandomizeToggles({});
    const clearedBypasses = new Set<string>();
    bypassedWidgetTargetsRef.current = clearedBypasses;
    appliedBypassDefaultsRef.current = clearedBypasses;
    shippedBypassRef.current = new Map();
    bypassWorkflowSourceRef.current = null;
    setBypassedWidgetTargets(clearedBypasses);
    widgetValuesWorkflowRef.current = null;
    replayCarryRef.current = null;
  }, [panelResetToken]);

  // Mirror the panel's own control values into the store so the project can
  // save them. Nothing submits from here — this is the persistence seam only.
  useEffect(() => {
    // Mid-reload the widgets are all absent while their values are kept, and
    // publishing now would describe the panel as having none.
    if (isReloadingSameWorkflow() && widgetInputs.length === 0) return;
    const widgetState = collectWidgetSubmissionState({
      widgetInputs,
      widgetValues,
      randomizeToggles,
      bypassedWidgetTargets,
    });
    const nextValues: GenerationPanelValuesSnapshot = {
      textValues,
      frontendStateWidgetValues: widgetState.frontendStateWidgetValues,
      derivedWidgetInputs: widgetState.derivedWidgetInputs,
      widgetModes: widgetState.widgetModes,
      bypassNodeIds: widgetState.bypassNodeIds,
      activateNodeIds: widgetState.activateNodeIds,
    };
    const carry = replayCarryRef.current;
    useGenerationStore
      .getState()
      .setPanelValues(
        withPendingReplayCarry(
          nextValues,
          carry?.workflowId === selectedWorkflowId ? carry : null,
        ),
      );
    // The carry is a ref: it only changes alongside the widget list, which is
    // already a dependency, and the reload flag belongs to that same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bypassedWidgetTargets,
    randomizeToggles,
    textValues,
    widgetInputs,
    widgetValues,
  ]);

  // Restore the state this project was left in. Held until here rather than
  // done at project load: seeding media slots renders timeline selections, so
  // it needs the loaded timeline and a reachable ComfyUI.
  useEffect(() => {
    if (!pendingPanelSnapshot) return;
    if (isRestoringPanelSnapshot) return;
    if (panelSnapshotRestoreFailed) return;
    if (connectionStatus !== "connected") return;

    void useGenerationStore
      .getState()
      .restorePanelSnapshot(pendingPanelSnapshot)
      .catch((error: unknown) => {
        console.warn(
          "[Generation] Failed to restore the project's panel state",
          error,
        );
      });
  }, [
    connectionStatus,
    isRestoringPanelSnapshot,
    panelSnapshotRestoreFailed,
    pendingPanelSnapshot,
  ]);

  useEffect(() => {
    const store = useGenerationStore.getState();
    store.connect();

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
                preparedMasksByKey: value.preparedMasksByKey ?? undefined,
                preparedMaskContentByKey:
                  value.preparedMaskContentByKey ?? undefined,
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

      // Stacked LoRAs are packed into their stack's leading loaders here, at
      // dispatch, and nowhere else: the panel and its saved state keep each
      // selection on the node the user picked it on.
      const packedLoras = packLoraStacks({
        widgetInputs: widgetInputsRef.current,
        widgetValues: currentWidgetValues,
        bypassedWidgetTargets: bypassedWidgetTargetsRef.current,
        rules: store.activeWorkflowRules,
      });
      // Widget overrides and randomization modes, from the same collector the
      // project's saved panel state is built from.
      const widgetSubmission = collectWidgetSubmissionState({
        widgetInputs: widgetInputsRef.current,
        widgetValues: packedLoras.widgetValues,
        randomizeToggles,
        bypassedWidgetTargets: packedLoras.bypassedWidgetTargets,
      });
      for (const nodeId of widgetSubmission.bypassNodeIds) {
        bypassNodeIds.add(nodeId);
      }
      for (const nodeId of widgetSubmission.activateNodeIds) {
        activateNodeIds.add(nodeId);
      }

      await queueGeneration(
        slotValues,
        widgetSubmission.widgetOverrides,
        widgetSubmission.widgetModes,
        widgetSubmission.derivedWidgetInputs,
        count,
        widgetSubmission.frontendStateWidgetValues,
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
      // Choosing a workflow by hand ends any wait for the saved one: from
      // here the panel is the user's, and what it holds is what gets saved.
      useGenerationStore.getState().discardPendingPanelSnapshot();
      setWorkflowLoadState("loading");
      void loadWorkflow(workflowId);
    },
    [loadWorkflow, setWorkflowLoadState],
  );

  const handleWorkflowBack = useCallback(() => {
    useGenerationStore.getState().discardPendingPanelSnapshot();
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
          setMediaInputAsset,
          prepare: async () => {
            const file = await resolveAssetFileForGeneration(asset);
            const sourceUrl = URL.createObjectURL(file);
            try {
              const durationTicks =
                typeof asset.duration === "number" && asset.duration > 0
                  ? mediaSecondsToTick(asset.duration)
                  : await probeVideoDurationTicks(sourceUrl);
              return { assetId: asset.id, sourceUrl, sourceFile: file, durationTicks };
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
    [assignAssetToInput, setMediaInputAsset, workflowInputById],
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
          setMediaInputAsset,
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
    [assignAssetToInput, setMediaInputAsset, workflowInputById],
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
      const bakedEdit = value.bakedEdit ?? undefined;

      setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
        mediaType: value.mediaType,
        bakedEdit,
        isExtracting: true,
        extractionRequestId,
      });

      if (timelineSelection.bakedSource && bakedEdit) {
        const mappings = mode === "manual" ? [] : useGenerationStore.getState().derivedMaskMappings.filter(
          (mapping) => mapping.sourceInputId === (input ? getWorkflowInputId(input) : inputId) ||
            (!mapping.sourceInputId && mapping.sourceNodeId === input?.nodeId),
        );
        void replayMiniEditorAssetEdit(bakedEdit, value.mediaType, mappings)
          .then(({ thumbnailFile: replayThumbnail, ...prepared }) => {
            if (selectionExtractionRequestIdsRef.current[inputId] !== extractionRequestId) return;
            setMediaInputTimelineSelection(inputId, timelineSelection, replayThumbnail, {
              mediaType: value.mediaType, bakedEdit, extractionRequestId,
              isExtracting: false, ...prepared,
            });
          })
          .catch((error: unknown) => {
            if (selectionExtractionRequestIdsRef.current[inputId] !== extractionRequestId) return;
            setMediaInputTimelineSelection(inputId, timelineSelection, thumbnailFile, {
              mediaType: value.mediaType, bakedEdit, extractionRequestId,
              isExtracting: false,
              extractionError: error instanceof Error ? error.message : "Failed to replay mini editor edit",
            });
          });
        return;
      }

      if (value.mediaType === "audio") {
        void extractAudioTimelineSelection({
          inputId,
          timelineSelection,
          bakedEdit,
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
        bakedEdit,
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

  /**
   * Attach a library asset named by id, for callers that address the library
   * rather than carry a dragged one — the generation session's `attachAsset`.
   * Placement is `assignAssetToInput`, the same path a drag takes, so the
   * audio extraction a video on an audio slot needs still happens.
   */
  const handleAttachAssetById = useCallback(
    (slotId: string, assetId: string) => {
      const asset = useAssetStore
        .getState()
        .assets.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      assignAssetToInput(slotId, asset);
    },
    [assignAssetToInput],
  );

  /** Read-only library lookup used to validate an attach before it is planned. */
  const resolveLibraryAsset = useCallback(
    (assetId: string) =>
      useAssetStore
        .getState()
        .assets.find((candidate) => candidate.id === assetId) ?? null,
    [],
  );

  const handleClickSelect = useCallback(
    (inputId: string, inputType: "image" | "video" | "audio", destination?: GenerationCaptureDestination) => {
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

            // Rendering the frame out of the timeline can take seconds, and
            // nothing lands in the slot until it is done; mark the slot so the
            // wait is visible rather than looking like the click was ignored.
            if (!destination) beginMediaInputPreparation(inputId);
            try {
              const frameFile = await captureFramePngAtTick(
                selectedTick,
                "generation-frame",
                undefined,
                { preserveMaskedPixels: true },
              );
              if (destination) {
                if (destination.active()) await destination.complete({ kind: "frame", file: frameFile, timelineSelection: createPointTimelineSelection(selectedTick) });
                return;
              }
              setMediaInputFrameWithSelection(
                inputId,
                frameFile,
                createPointTimelineSelection(selectedTick),
              );
            } catch (error) {
              destination?.fail(error instanceof Error ? error.message : "Frame capture failed.");
              console.error("Failed to capture generation image frame", error);
            } finally {
              if (!destination) endMediaInputPreparation(inputId);
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
      // The workflow's grid and fps seed the range and then own the selection:
      // they are passed in rather than written to the store beforehand, which
      // still describes whatever selection ran last.
      const selectionEndTick = getDefaultSelectionEnd(selectionStartTick, {
        fps: recommendedFps,
        frameStep: recommendedFrameStep,
        frameOffset: recommendedFrameOffset,
      });

      timelineSelectionStore.enterSelectionMode(
        selectionStartTick,
        selectionEndTick,
        {
          message: selectionConfig?.message ?? null,
          includeTracks: selectionConfig?.includeTracks === true,
          frameStep: recommendedFrameStep,
          frameOffset: recommendedFrameOffset,
          fpsOverride: recommendedFps,
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

          // Held from the moment the range is confirmed: the thumbnail render
          // that precedes the slot's first value takes seconds of its own, and
          // `isExtracting` on that value cannot describe a value that does not
          // exist yet.
          if (!destination) beginMediaInputPreparation(inputId);
          try {
            const { selectionStartTick, selectionEndTick } =
              useTimelineSelectionStore.getState();
            const timelineSelection = applySelectionConfigDefaults(
              createTimelineSelection(selectionStartTick, selectionEndTick),
              selectionConfig,
            );
            closeSelectionMode();
            if (destination && !destination.active()) return;
            const thumbnailFile =
              inputType === "audio"
                ? createAudioSelectionPlaceholderFile()
                : await captureFramePngAtTick(
                    selectionStartTick,
                    "generation-selection-thumb",
                    timelineSelection,
                  );
            // A held draft owns its extraction; it must not invalidate a native
            // slot's in-flight request or write a pending value to that slot.
            const requestIds = destination ? { current: {} as Record<string, number> } : selectionExtractionRequestIdsRef;
            const extractionRequestId = (requestIds.current[inputId] ?? 0) + 1;
            requestIds.current[inputId] = extractionRequestId;
            const captured: { value: GenerationCapturedMedia | null } = { value: null };
            const writeSelection: typeof setMediaInputTimelineSelection = destination
              ? (_id, selection, thumbnail, options) => {
                captured.value = { kind: "timelineSelection", timelineSelection: selection, thumbnailFile: thumbnail, options };
              }
              : setMediaInputTimelineSelection;

            writeSelection(inputId, timelineSelection, thumbnailFile, {
              mediaType: inputType === "audio" ? "audio" : "video",
              isExtracting: true,
              extractionRequestId,
            });

            if (inputType === "audio") {
              await extractAudioTimelineSelection({
                inputId, timelineSelection, thumbnailFile, extractionRequestId,
                exportFps: recommendedFps ?? undefined,
                setMediaInputTimelineSelection: writeSelection,
                selectionExtractionRequestIdsRef: requestIds,
              });
            } else {
              await extractVideoTimelineSelection({
                inputId, inputNodeId: input?.nodeId, timelineSelection, thumbnailFile,
                extractionRequestId, mode, derivedMaskMappings,
                setMediaInputTimelineSelection: writeSelection,
                selectionExtractionRequestIdsRef: requestIds,
              });
            }
            if (destination?.active() && captured.value) {
              const capture = captured.value;
              if (capture.kind === "timelineSelection" && capture.options?.extractionError) {
                destination.fail(capture.options.extractionError);
              } else {
                await destination.complete(capture);
              }
            }
          } catch (error) {
            if (destination) {
              destination.fail(error instanceof Error ? error.message : "Timeline extraction failed.");
              return;
            }
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
            if (!destination) endMediaInputPreparation(inputId);
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

  useEffect(() => registerGenerationInputCapture(handleClickSelect), [handleClickSelect]);

  /**
   * Trims an audio slot in the mini editor. Same two shapes the video editor
   * works in: a real timeline selection is rebuilt and re-extracted through the
   * normal path, while media with no backing timeline is trimmed into a baked
   * value that remembers what it was cut from, so a second edit composes on the
   * source instead of cropping the crop.
   */
  const handleEditAudioMedia = useCallback(
    (inputId: string) => {
      const { input, value } = readSlotValueForEdit(inputId, workflowInputById);
      if (!value) return;
      // An edit keeps the attachment: whatever refers to this item by identity
      // still means it after the range is narrowed.
      const editedItemId = value.itemId;

      if (usePlayerStore.getState().isPlaying) {
        usePlayerStore.getState().setIsPlaying(false);
      }

      let sourceSelection: TimelineSelection | null = null;
      let bakeOriginAssetId: string | null = null;
      let editorInitial: MiniEditorInitialState | undefined;
      let prepare: () => Promise<ResolvedEditorSource>;

      // Duration first: the editor owns the object URL once it has one, and a
      // probe that throws before then would leak it.
      const prepareFromFile =
        (file: File, assetId?: string) =>
        async (): Promise<ResolvedEditorSource> => {
          const durationTicks = await probeAudioDurationTicks(file);
          return {
            ...(assetId ? { assetId } : {}),
            sourceUrl: URL.createObjectURL(file),
            sourceFile: file,
            durationTicks,
            mediaType: "audio",
          };
        };

      // A video on an audio slot contributes its track and never itself, so
      // the editor opens on the audio pulled out of it.
      const prepareFromAsset =
        (asset: Asset) => async (): Promise<ResolvedEditorSource> => {
          const file = await resolveAssetFileForGeneration(asset);
          const audioFile = isAudioSlotVideoAsset(asset)
            ? await extractAudioFromVideo(file)
            : file;
          if (!audioFile) throw new Error(NO_ASSET_AUDIO_TRACK_MESSAGE);
          return prepareFromFile(audioFile, asset.id)();
        };

      if (value.kind === "asset") {
        bakeOriginAssetId = value.asset.id;
        if (isAudioSlotVideoAsset(value.asset)) {
          // The track was pulled out when the video was dropped; opening the
          // editor must not decode it a second time.
          const extractedAudioFile = value.extractedAudioFile;
          if (!extractedAudioFile) return;
          prepare = prepareFromFile(extractedAudioFile, value.asset.id);
        } else {
          prepare = prepareFromAsset(value.asset);
        }
      } else if (
        value.kind === "timelineSelection" &&
        value.mediaType === "audio" &&
        value.timelineSelection.bakedSource
      ) {
        // Re-edit of a trim: reopen what it was trimmed from with the edit
        // restored, so this save replaces that crop rather than nesting inside
        // it.
        const originAsset = value.bakedEdit?.assetId
          ? getAssets().find(
              (candidate) => candidate.id === value.bakedEdit?.assetId,
            )
          : undefined;
        editorInitial = value.bakedEdit?.spec;
        if (originAsset) {
          bakeOriginAssetId = originAsset.id;
          prepare = prepareFromAsset(originAsset);
        } else {
          // The source asset is gone. The trim itself becomes the source, and
          // the stored spec no longer describes it.
          const trimmedFile = value.preparedAudioFile;
          if (!trimmedFile) return;
          editorInitial = undefined;
          prepare = prepareFromFile(trimmedFile);
        }
      } else if (
        value.kind === "timelineSelection" &&
        value.mediaType === "audio"
      ) {
        const selection = value.bakedEdit?.timelineSelection ?? value.timelineSelection;
        editorInitial = value.bakedEdit?.timelineSelection ? value.bakedEdit.spec : undefined;
        sourceSelection = selection;
        // The rendered audio spans exactly the selection, so the editor's crop
        // ticks are already selection-relative — what the rebuild expects.
        const preparedAudioFile = value.bakedEdit?.timelineSelection ? null : value.preparedAudioFile;
        prepare = async () => {
          const file =
            preparedAudioFile ??
            (await extractAudioFromSelection(selection, {
              exportFps: resolveEditAudioExportFps(input),
            }));
          if (!file) throw new Error(NO_SELECTION_AUDIO_TRACK_MESSAGE);
          const durationTicks =
            !selection.isPoint
              ? Math.max(0, selection.durationTicks)
              : await probeAudioDurationTicks(file);
          return {
            sourceUrl: URL.createObjectURL(file),
            sourceFile: file,
            durationTicks,
            mediaType: "audio",
          };
        };
      } else {
        return;
      }

      const onSave = async (
        spec: MiniEditorEditSpec,
        source: ResolvedEditorSource,
      ) => {
        const thumbnailFile = createAudioSelectionPlaceholderFile();
        const extractionRequestId =
          (selectionExtractionRequestIdsRef.current[inputId] ?? 0) + 1;
        selectionExtractionRequestIdsRef.current[inputId] = extractionRequestId;

        // Timeline-selection inputs: narrow the real selection and re-extract
        // it, so the audio still comes off the timeline with every clip, level
        // and transform the original selection carried.
        if (sourceSelection) {
          const bakedEdit: GenerationBakedEditOrigin = {
            assetId: null,
            timelineSelection: structuredClone(sourceSelection),
            spec: structuredClone(spec),
          };
          const editedSelection = buildEditedTimelineSelection(sourceSelection, {
            ...spec,
            // Range masks are a visual matte; an audio slot never has any.
            ranges: [],
          });
          setMediaInputTimelineSelection(
            inputId,
            editedSelection,
            thumbnailFile,
            {
              mediaType: "audio",
              bakedEdit,
              isExtracting: true,
              extractionRequestId,
              itemId: editedItemId,
            },
          );
          await extractAudioTimelineSelection({
            inputId,
            timelineSelection: editedSelection,
            bakedEdit,
            thumbnailFile,
            extractionRequestId,
            exportFps: resolveEditAudioExportFps(input),
            setMediaInputTimelineSelection,
            selectionExtractionRequestIdsRef,
          });
          return;
        }

        // Plain media: trim the file itself. Failing here throws rather than
        // writing an empty value back — the editor stays open with the error
        // and the slot keeps the media it had.
        const trimmedFile = await trimAudioFile(
          source.sourceFile,
          spec.cropStartTicks,
          spec.cropEndTicks,
        );
        if (!trimmedFile) {
          throw new Error("The selected range could not be trimmed.");
        }
        setMediaInputTimelineSelection(
          inputId,
          projectTimelineSelection({ start: 0, end: Math.max(1, spec.cropEndTicks - spec.cropStartTicks), clips: [], bakedSource: true }, { clips: [], tracks: [], fps: 30 }),
          thumbnailFile,
          {
            mediaType: "audio",
            isExtracting: false,
            extractionRequestId,
            itemId: editedItemId,
            preparedAudioFile: trimmedFile,
            bakedEdit: { assetId: bakeOriginAssetId, spec: structuredClone(spec) },
          },
        );
      };

      void useMiniEditorStore.getState().open({
        openerId: "generation-panel",
        title: input?.label ? `Edit: ${input.label}` : "Edit audio",
        prepare,
        onSave,
        initial: editorInitial,
        frameConstraint: resolveEditorFrameConstraint(
          sourceSelection,
          input?.dispatch?.selectionConfig,
        ),
      });
    },
    [setMediaInputTimelineSelection, workflowInputById],
  );

  const handleEditMedia = useCallback(
    (inputId: string, inputType: "video" | "audio") => {
      if (inputType === "audio") {
        handleEditAudioMedia(inputId);
        return;
      }
      const { input, value } = readSlotValueForEdit(inputId, workflowInputById);
      if (!value) return;
      // An edit keeps the attachment: whatever refers to this item by identity
      // still means it after the range is narrowed.
      const editedItemId = value.itemId;

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
      // Origin the synthetic bake re-renders from, and the edit already applied
      // to it. A baked input re-opens its *source*, not its bake: the bake has
      // no clips, so extracting it would render an empty timeline.
      let bakeOriginAssetId: string | null = null;
      let editorInitial: MiniEditorInitialState | undefined;
      // Per-item audio inclusion belongs to the media, and a bake replaces the
      // value in place (asset -> baked selection), so it has to be carried
      // across the kind change explicitly — a mute included, or the new value
      // would start from the slot's audio-on default.
      const includeEmbeddedAudio = readIncludeEmbeddedAudio(value);

      const prepareFromAsset =
        (asset: Asset) => async (): Promise<ResolvedEditorSource> => {
          const file = await resolveAssetFileForGeneration(asset);
          const videoUrl = URL.createObjectURL(file);
          const durationTicks =
            typeof asset.duration === "number" && asset.duration > 0
              ? mediaSecondsToTick(asset.duration)
              : await probeVideoDurationTicks(videoUrl);
          return {
            assetId: asset.id,
            fps: asset.fps,
            sourceUrl: videoUrl,
            sourceFile: file,
            durationTicks,
          };
        };

      if (value.kind === "asset" && value.asset.type === "video") {
        bakeOriginAssetId = value.asset.id;
        prepare = prepareFromAsset(value.asset);
      } else if (
        value.kind === "timelineSelection" &&
        value.mediaType === "video" &&
        value.timelineSelection.bakedSource
      ) {
        // Re-edit of a bake: reopen the asset it was baked from with the edit
        // restored, so this save composes on the source instead of stacking a
        // second crop onto the already-cropped output.
        const originAsset = value.bakedEdit?.assetId
          ? getAssets().find(
              (candidate) => candidate.id === value.bakedEdit?.assetId,
            )
          : undefined;
        editorInitial = value.bakedEdit?.spec;
        if (originAsset) {
          bakeOriginAssetId = originAsset.id;
          prepare = prepareFromAsset(originAsset);
        } else {
          // The source asset is gone. The bake itself becomes the source: it
          // is already cropped, so the stored spec no longer applies to it.
          const bakedFile = value.preparedVideoFile;
          if (!bakedFile) return;
          editorInitial = undefined;
          prepare = async () => {
            const videoUrl = URL.createObjectURL(bakedFile);
            return {
              sourceUrl: videoUrl,
              sourceFile: bakedFile,
              durationTicks: await probeVideoDurationTicks(videoUrl),
            };
          };
        }
      } else if (
        value.kind === "timelineSelection" &&
        value.mediaType === "video"
      ) {
        const selection = value.bakedEdit?.timelineSelection ?? value.timelineSelection;
        const { ranges, previewSelection } =
          getTimelineSelectionEditorState(selection);
        editorInitial = value.bakedEdit?.timelineSelection ? value.bakedEdit.spec : { ranges };
        // A cached render may already contain these masks. Preview their
        // underlying frames so shrinking or deleting a range reveals video.
        const existingPrepared =
          !value.bakedEdit?.timelineSelection && ranges.length === 0 ? value.preparedVideoFile : null;
        sourceSelection = selection;
        prepare = async () => {
          const file =
            existingPrepared ??
            (await renderTimelineSelectionToMp4(previewSelection));
          const videoUrl = URL.createObjectURL(file);
          const durationTicks =
            !selection.isPoint
              ? Math.max(0, selection.durationTicks)
              : await probeVideoDurationTicks(videoUrl);
          return {
            sourceUrl: videoUrl,
            sourceFile: file,
            durationTicks,
            fps: selection.fps,
          };
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
          const bakedEdit: GenerationBakedEditOrigin = {
            assetId: null,
            timelineSelection: structuredClone(sourceSelection),
            spec: structuredClone(spec),
          };
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
              bakedEdit,
              isExtracting: true,
              extractionRequestId,
              itemId: editedItemId,
            },
          );
          await extractVideoTimelineSelection({
            inputId,
            inputNodeId: input?.nodeId,
            timelineSelection: editedSelection,
            bakedEdit,
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
        // The bake is the only render this input will ever get — the stored
        // selection has no clips — so the pair it produces has to satisfy the
        // workflow's derived-mask mapping exactly, signature included.
        const { sourceWidth, sourceHeight } = useMiniEditorStore.getState();
        const dims = {
          width: sourceWidth > 0 ? sourceWidth : 1280,
          height: sourceHeight > 0 ? sourceHeight : 720,
          fps: Math.max(1, useProjectStore.getState().config.fps),
        };
        const visualMasks =
          mode === "manual"
            ? []
            : derivedMaskMappings.filter(
                (mapping) =>
                  mapping.purpose !== "audio_timing" &&
                  (mapping.sourceInputId === inputId ||
                    (!mapping.sourceInputId &&
                      mapping.sourceNodeId === input?.nodeId)),
              );
        const prepared = await bakeMiniEditorVideo(spec, source, dims, visualMasks);
        const cropLen = Math.max(1, spec.cropEndTicks - spec.cropStartTicks);

        setMediaInputTimelineSelection(
          inputId,
          projectTimelineSelection({ start: 0, end: cropLen, clips: [], bakedSource: true }, { clips: [], tracks: [], fps: 30 }),
          thumbnailFile,
          {
            mediaType: "video",
            isExtracting: false,
            extractionRequestId,
            itemId: editedItemId,
            ...prepared,
            bakedEdit: { assetId: bakeOriginAssetId, spec: structuredClone(spec), render: dims },
            includeEmbeddedAudio,
          },
        );
      };

      void useMiniEditorStore.getState().open({
        openerId: "generation-panel",
        title: input?.label ? `Edit: ${input.label}` : "Edit video",
        prepare,
        onSave,
        initial: editorInitial,
        // Inherit the workflow's frame-step constraint so the crop is stepped.
        frameConstraint: resolveEditorFrameConstraint(
          sourceSelection,
          input?.dispatch?.selectionConfig,
        ),
      });
    },
    [
      derivedMaskMappings,
      handleEditAudioMedia,
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
      (asset) => getTimelineSelectionStartFromAsset(asset) !== null,
    );
  }, [importedAssets]);

  const handleSendToTimeline = useCallback(() => {
    for (const asset of sendableAssets) {
      const start = getTimelineSelectionStartFromAsset(asset);
      if (start !== null) {
        insertAssetAtTime(asset, start);
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
    presentedWidgetInputs,
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
    handleAttachAssetById,
    resolveLibraryAsset,
    handleClickSelect,
    handleEditMedia,
  };
}
