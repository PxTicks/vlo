import { create } from "zustand";
import {
  ComfyUIWebSocket,
  type ComfyUIEvent,
  type ComfyUIPreview,
} from "./services/ComfyUIWebSocket";
import * as comfyApi from "./services/comfyuiApi";
import {
  frontendPreprocess,
  frontendPostprocess,
  type SlotValue,
} from "./utils/pipeline";
import type { WorkflowWarningSummary } from "./services/workflowBridge";
import type {
  GenerationJob,
  GenerationMediaInputValue,
  GenerationPipelineStatus,
  WorkflowInput,
  WorkflowLoadState,
  WorkflowMaskCroppingMode,
} from "./types";
import { API_BASE_URL } from "../../config";
import { getRuntimeStatus } from "../../services/runtimeApi";
import type { Asset, GeneratedCreationMetadata } from "../../types/Asset";
import type { RuntimeStatus } from "../../types/RuntimeStatus";
import type { TimelineSelection } from "../../types/TimelineTypes";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  DEFAULT_WORKFLOW_POSTPROCESSING,
  getClosestWorkflowResolution,
  getSupportedWorkflowResolutions,
  type WorkflowRuleWarning,
  type WorkflowRules,
} from "./services/workflowRules";
import type { DerivedMaskSourceVideoTreatment } from "./derivedMaskVideoTreatment";
import type { DerivedMaskMapping } from "./pipeline/types";
import { parseNodeOutputItems } from "./services/parsers";
import { mergeRuleWarnings } from "./services/warnings";
import { injectWorkflowAndRead } from "./services/workflowSyncController";
import {
  isTemporaryWorkflowDuplicateFilename,
  isSafeWorkflowFilename,
  normalizeWorkflowFilename,
} from "./services/workflowFilenames";
import { createSubmissionErrorJob } from "./store/submission";
import { pruneMediaInputs, revokePreviewUrl } from "./store/mediaInputState";
import { getHistoryOutputsWithRetry } from "./store/history";
import {
  applyPresentationRules,
  EMPTY_WORKFLOW_RULES,
} from "./store/workflowState";
import { isAbortError } from "./pipeline/utils/abort";
import {
  mergeInputNodeMap,
  type InputNodeMap,
} from "./constants/inputNodeMap";
import {
  buildWorkflowInputLookup,
  getWorkflowInputValue,
  resolveWorkflowInputKeys,
} from "./utils/workflowInputs";

export type ComfyUIConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface TempWorkflow {
  workflow: Record<string, unknown>;
  graphData: Record<string, unknown>;
  inputs: WorkflowInput[];
}

type WorkflowOption = { id: string; name: string };

export const TEMP_WORKFLOW_ID = "__temp__";
const TEMP_WORKFLOW_DISPLAY_NAME = "Edited Workflow";
const IDLE_PIPELINE_STATUS: GenerationPipelineStatus = {
  phase: "idle",
  message: null,
  interruptible: false,
};

function connectionStatusFromRuntime(
  runtimeStatus: RuntimeStatus | null,
): ComfyUIConnectionStatus {
  if (!runtimeStatus) return "disconnected";
  if (runtimeStatus.comfyui.status === "connected") return "connected";
  if (runtimeStatus.comfyui.status === "invalid_config") return "error";
  return "disconnected";
}

function revokeJobPostprocessPreview(job: GenerationJob | null | undefined) {
  const previewUrl = job?.postprocessedPreview?.previewUrl;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
}

export interface PreviewAnimation {
  frameUrls: (string | null)[];
  frameRate: number;
  totalFrames: number;
}

function revokePreviewAnimation(animation: PreviewAnimation | null): void {
  if (!animation) return;
  for (const url of animation.frameUrls) {
    if (url) URL.revokeObjectURL(url);
  }
}

function replacePreviewAnimation(
  currentAnimation: PreviewAnimation | null,
  nextAnimation: PreviewAnimation | null,
): PreviewAnimation | null {
  if (currentAnimation === nextAnimation) {
    return nextAnimation;
  }
  revokePreviewAnimation(currentAnimation);
  return nextAnimation;
}

function getPreviewFrameExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "png";
}

function getPreviewFrameIndex(
  preview: ComfyUIPreview,
  existingFrames: File[],
): number {
  if (
    typeof preview.frameIndex === "number" &&
    Number.isInteger(preview.frameIndex) &&
    preview.frameIndex >= 0
  ) {
    return preview.frameIndex;
  }
  return existingFrames.length;
}

function resolveWorkflowDisplayName(
  availableWorkflows: WorkflowOption[],
  selectedWorkflowId: string | null,
  workflowId: string | null,
): string {
  const bySelectedId = selectedWorkflowId
    ? availableWorkflows.find((workflow) => workflow.id === selectedWorkflowId)
    : null;
  if (bySelectedId?.name) return bySelectedId.name;

  const byWorkflowId = workflowId
    ? availableWorkflows.find((workflow) => workflow.id === workflowId)
    : null;
  if (byWorkflowId?.name) return byWorkflowId.name;

  return workflowId ?? selectedWorkflowId ?? "Unknown Workflow";
}

function formatWorkflowName(filename: string): string {
  return filename.replace(/\.json$/i, "");
}

function resolveWorkflowPersistenceId(
  selectedWorkflowId: string | null,
  filename: string | null,
): string | null {
  const normalizedFilename =
    filename && isSafeWorkflowFilename(filename)
      ? normalizeWorkflowFilename(filename)
      : null;
  const normalizedSelectedWorkflowId =
    selectedWorkflowId &&
    selectedWorkflowId !== TEMP_WORKFLOW_ID &&
    isSafeWorkflowFilename(selectedWorkflowId)
      ? normalizeWorkflowFilename(selectedWorkflowId)
      : null;
  if (
    normalizedFilename &&
    normalizedSelectedWorkflowId &&
    isTemporaryWorkflowDuplicateFilename(
      normalizedFilename,
      normalizedSelectedWorkflowId,
    )
  ) {
    return normalizedSelectedWorkflowId;
  }
  if (normalizedFilename) {
    return normalizedFilename;
  }

  if (normalizedSelectedWorkflowId) {
    return normalizedSelectedWorkflowId;
  }

  return null;
}

function sortWorkflowOptions(
  workflows: WorkflowOption[],
): WorkflowOption[] {
  return [...workflows].sort((a, b) => a.name.localeCompare(b.name));
}

function upsertWorkflowOption(
  workflows: WorkflowOption[],
  workflow: WorkflowOption,
): WorkflowOption[] {
  const existingIndex = workflows.findIndex((item) => item.id === workflow.id);
  const next = [...workflows];

  if (existingIndex >= 0) {
    next[existingIndex] = workflow;
  } else {
    next.push(workflow);
  }

  return sortWorkflowOptions(next);
}

function removeWorkflowOption(
  workflows: WorkflowOption[],
  workflowId: string,
): WorkflowOption[] {
  return workflows.filter((workflow) => workflow.id !== workflowId);
}

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

function buildGeneratedCreationMetadata(
  workflowName: string,
  workflowInputs: WorkflowInput[],
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
): GeneratedCreationMetadata {
  const inputs: GeneratedCreationMetadata["inputs"] = [];
  const inputById = buildWorkflowInputLookup(workflowInputs);

  for (const workflowInput of workflowInputs) {
    const value = getWorkflowInputValue(mediaInputs, workflowInput, inputById);
    if (!value) continue;

    if (value.kind === "timelineSelection") {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "timelineSelection",
        timelineSelection: value.timelineSelection,
      });
      continue;
    }

    if (value.kind === "asset") {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "draggedAsset",
        parentAssetId: value.asset.id,
      });
    }
  }

  return {
    source: "generated",
    workflowName,
    inputs,
  };
}

function findPreparedMaskFallback(
  slotValues: Record<string, SlotValue>,
  derivedMaskMappings: DerivedMaskMapping[],
  workflowInputs: WorkflowInput[],
): File | null {
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const inputsByNodeId = new Map<string, WorkflowInput[]>();
  for (const input of workflowInputs) {
    const existing = inputsByNodeId.get(input.nodeId) ?? [];
    existing.push(input);
    inputsByNodeId.set(input.nodeId, existing);
  }

  for (const mapping of derivedMaskMappings) {
    if (mapping.sourceInputId) {
      const sourceInput = inputById.get(mapping.sourceInputId);
      const value = sourceInput
        ? getWorkflowInputValue(slotValues, sourceInput, inputById)
        : slotValues[mapping.sourceInputId];
      if (value?.type === "video_selection" && value.preparedMaskFile) {
        return value.preparedMaskFile;
      }
      continue;
    }

    for (const input of inputsByNodeId.get(mapping.sourceNodeId) ?? []) {
      const value = getWorkflowInputValue(slotValues, input, inputById);
      if (value?.type === "video_selection" && value.preparedMaskFile) {
        return value.preparedMaskFile;
      }
    }
  }

  return null;
}

function isActiveGenerationJob(job: GenerationJob | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}

function removeMediaInputEntries(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  inputIds: readonly string[],
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };

  for (const inputId of new Set(inputIds)) {
    revokePreviewUrl(next[inputId]);
    delete next[inputId];
  }

  return next;
}

interface GenerationStore {
  connectionStatus: ComfyUIConnectionStatus;
  runtimeStatus: RuntimeStatus | null;
  runtimeStatusError: string | null;
  comfyuiDirectUrl: string | null;
  wsClient: ComfyUIWebSocket | null;
  pipelineStatus: GenerationPipelineStatus;
  pipelineRunToken: number;
  preprocessAbortController: AbortController | null;

  // Synced workflow from ComfyUI editor
  syncedWorkflow: Record<string, unknown> | null;
  syncedGraphData: Record<string, unknown> | null;
  workflowInputs: WorkflowInput[];

  // Workflow Selection
  availableWorkflows: WorkflowOption[];
  tempWorkflow: TempWorkflow | null;
  selectedWorkflowId: string | null;
  isWorkflowLoading: boolean;
  workflowLoadState: WorkflowLoadState;
  workflowLoadError: string | null;
  isWorkflowReady: boolean;
  workflowWarning: WorkflowWarningSummary | null;
  hasInferredInputs: boolean;
  workflowRuleWarnings: WorkflowRuleWarning[];
  activeWorkflowRules: WorkflowRules | null;
  rulesWorkflowSourceId: string | null;
  activeRulesWarnings: WorkflowRuleWarning[];
  derivedMaskMappings: DerivedMaskMapping[];
  maskCropMode: WorkflowMaskCroppingMode;
  targetResolution: number;
  setTargetResolution: (resolution: number) => void;
  setMaskCropMode: (mode: WorkflowMaskCroppingMode) => void;
  maskCropDilation: number;
  setMaskCropDilation: (dilation: number) => void;
  lastAppliedWidgetValues: Record<string, string>;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;

  jobs: Map<string, GenerationJob>;
  jobPreviewFrames: Map<string, File[]>;
  activeJobId: string | null;
  latestPreviewUrl: string | null;
  previewAnimation: PreviewAnimation | null;
  objectInfoSynced: boolean;
  inputNodeMap: InputNodeMap | null;

  // Editor Integration
  editorRef: HTMLIFrameElement | null;
  editorNeedsReconnect: boolean;
  editorReconnectSignal: number;
  registerEditor: (iframe: HTMLIFrameElement) => void;
  unregisterEditor: () => void;
  setWorkflowLoading: (loading: boolean) => void;
  setWorkflowLoadState: (state: WorkflowLoadState) => void;
  setEditorNeedsReconnect: (required: boolean) => void;
  requestEditorReconnect: () => void;
  clearWorkflowWarning: () => void;
  clearWorkflowLoadError: () => void;
  setMediaInputAsset: (inputId: string, asset: Asset) => void;
  setMediaInputFrame: (inputId: string, file: File) => void;
  setMediaInputTimelineSelection: (
    inputId: string,
    timelineSelection: TimelineSelection,
    thumbnailFile: File,
    options?: {
      isExtracting?: boolean;
      extractionRequestId?: number;
      preparedVideoFile?: File | null;
      preparedMaskFile?: File | null;
      preparedDerivedMaskVideoTreatment?: DerivedMaskSourceVideoTreatment | null;
      extractionError?: string | null;
    },
  ) => void;
  clearMediaInput: (inputId: string) => void;

  connect: () => void;
  disconnect: () => void;
  refreshRuntimeStatus: () => Promise<RuntimeStatus | null>;
  updateComfyUrl: (url: string) => Promise<void>;
  syncWorkflow: (
    workflow: Record<string, unknown>,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
  ) => void;
  registerWorkflowFromEditor: (
    workflow: Record<string, unknown>,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
    filename: string | null,
  ) => Promise<void>;

  fetchWorkflows: () => Promise<void>;
  syncObjectInfo: () => Promise<void>;
  loadWorkflow: (filename: string) => Promise<void>;

  submitGeneration: (
    slotValues: Record<string, SlotValue>,
    widgetInputs?: Record<string, string>,
    widgetModes?: Record<string, "fixed" | "randomize">,
    derivedWidgetInputs?: Record<string, string>,
  ) => Promise<string | null>;
  cancelGeneration: () => Promise<void>;
  importOutput: (jobId: string, outputIndex: number) => Promise<void>;
  clearJob: (jobId: string) => void;
}

let latestWorkflowLoadRequestId = 0;

export const useGenerationStore = create<GenerationStore>((set, get) => ({
  connectionStatus: "disconnected",
  runtimeStatus: null,
  runtimeStatusError: null,
  comfyuiDirectUrl: null,
  wsClient: null,
  pipelineStatus: IDLE_PIPELINE_STATUS,
  pipelineRunToken: 0,
  preprocessAbortController: null,
  syncedWorkflow: null,
  syncedGraphData: null,
  workflowInputs: [],
  availableWorkflows: [],
  tempWorkflow: null,
  selectedWorkflowId: null,
  isWorkflowLoading: true, // Start true until initial check completes
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
  lastAppliedWidgetValues: {},
  mediaInputs: {},
  jobs: new Map(),
  jobPreviewFrames: new Map(),
  activeJobId: null,
  latestPreviewUrl: null,
  previewAnimation: null,
  objectInfoSynced: false,
  inputNodeMap: null,
  editorRef: null,
  editorNeedsReconnect: false,
  editorReconnectSignal: 0,

  registerEditor: (iframe) => {
    set({ editorRef: iframe });

    const { selectedWorkflowId, isWorkflowLoading, workflowInputs } = get();
    if (!selectedWorkflowId) return;

    // Startup can load a workflow before the iframe ref exists. Retry once the
    // editor is registered so inputs appear without manual workflow switching.
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
  setEditorNeedsReconnect: (required) =>
    set({ editorNeedsReconnect: required }),
  requestEditorReconnect: () =>
    set((state) => ({
      editorNeedsReconnect: false,
      editorReconnectSignal: state.editorReconnectSignal + 1,
    })),
  clearWorkflowWarning: () => set({ workflowWarning: null }),
  clearWorkflowLoadError: () => set({ workflowLoadError: null }),
  setMediaInputAsset: (inputId, asset) =>
    set((state) => {
      const inputById = buildWorkflowInputLookup(state.workflowInputs);
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const canonicalInputId = inputKeys[0] ?? inputId;
      return {
        mediaInputs: {
          ...removeMediaInputEntries(state.mediaInputs, inputKeys),
          [canonicalInputId]: { kind: "asset", asset },
        },
      };
    }),
  setMediaInputFrame: (inputId, file) =>
    set((state) => {
      const inputById = buildWorkflowInputLookup(state.workflowInputs);
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const canonicalInputId = inputKeys[0] ?? inputId;
      return {
        mediaInputs: {
          ...removeMediaInputEntries(state.mediaInputs, inputKeys),
          [canonicalInputId]: {
            kind: "frame",
            file,
            previewUrl: URL.createObjectURL(file),
          },
        },
      };
  }),
  setMediaInputTimelineSelection: (
    inputId,
    timelineSelection,
    thumbnailFile,
    options,
  ) =>
    set((state) => {
      const inputById = buildWorkflowInputLookup(state.workflowInputs);
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const canonicalInputId = inputKeys[0] ?? inputId;
      return {
        mediaInputs: {
          ...removeMediaInputEntries(state.mediaInputs, inputKeys),
          [canonicalInputId]: {
            kind: "timelineSelection",
            timelineSelection,
            thumbnailFile,
            thumbnailUrl: URL.createObjectURL(thumbnailFile),
            isExtracting: options?.isExtracting ?? false,
            extractionRequestId: options?.extractionRequestId ?? 0,
            preparedVideoFile: options?.preparedVideoFile ?? null,
            preparedMaskFile: options?.preparedMaskFile ?? null,
            preparedDerivedMaskVideoTreatment:
              options?.preparedDerivedMaskVideoTreatment ?? null,
            extractionError: options?.extractionError ?? null,
          },
        },
      };
    }),
  clearMediaInput: (inputId) =>
    set((state) => {
      const inputById = buildWorkflowInputLookup(state.workflowInputs);
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const hasMatchingEntry = inputKeys.some((key) =>
        Object.prototype.hasOwnProperty.call(state.mediaInputs, key),
      );
      if (!hasMatchingEntry) return {};
      return {
        mediaInputs: removeMediaInputEntries(state.mediaInputs, inputKeys),
      };
    }),

  refreshRuntimeStatus: async () => {
    try {
      const runtimeStatus = await getRuntimeStatus();
      set((state) => {
        const nextState: Partial<GenerationStore> = {
          runtimeStatus,
          runtimeStatusError: null,
          comfyuiDirectUrl: runtimeStatus.comfyui.url,
          connectionStatus: connectionStatusFromRuntime(runtimeStatus),
        };

        if (
          runtimeStatus.comfyui.status !== "connected" &&
          state.isWorkflowLoading
        ) {
          nextState.isWorkflowLoading = false;
          nextState.workflowLoadState = state.syncedWorkflow ? "ready" : "error";
          nextState.isWorkflowReady = state.syncedWorkflow !== null;
          nextState.workflowLoadError =
            runtimeStatus.comfyui.error ??
            "ComfyUI is unavailable. Start it and retry loading inputs.";
        }

        if (
          runtimeStatus.comfyui.status === "connected" &&
          state.connectionStatus !== "connected"
        ) {
          get().requestEditorReconnect();
        }

        return nextState;
      });
      return runtimeStatus;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Backend status check failed";
      set((state) => ({
        runtimeStatus: null,
        runtimeStatusError: message,
        connectionStatus: "error",
        ...(state.isWorkflowLoading
          ? {
              isWorkflowLoading: false,
              workflowLoadState: state.syncedWorkflow ? "ready" : "error",
              isWorkflowReady: state.syncedWorkflow !== null,
              workflowLoadError: message,
            }
          : {}),
      }));
      return null;
    }
  },

  connect: () => {
    const existing = get().wsClient;
    if (existing) {
      void get().refreshRuntimeStatus();
      if (!existing.isConnected) {
        set({ connectionStatus: "connecting" });
        existing.connect();
      }
      return;
    }

    set({ connectionStatus: "connecting" });
    void get().refreshRuntimeStatus();

    const client = new ComfyUIWebSocket(API_BASE_URL);
    const failActiveJob = (
      errorMessage: string,
      nextConnectionStatus: ComfyUIConnectionStatus,
    ) => {
      set((state) => {
        const activeJobId = state.activeJobId;
        if (!activeJobId) {
          return { connectionStatus: nextConnectionStatus };
        }

        const activeJob = state.jobs.get(activeJobId);
        if (
          !activeJob ||
          (activeJob.status !== "running" && activeJob.status !== "queued")
        ) {
          return { connectionStatus: nextConnectionStatus };
        }

        const updated = new Map(state.jobs);
        updated.set(activeJobId, {
          ...activeJob,
          status: "error",
          error: errorMessage,
          currentNode: null,
          completedAt: Date.now(),
        });
        const nextPreviewFrames = new Map(state.jobPreviewFrames);
        nextPreviewFrames.delete(activeJobId);
        revokePreviewAnimation(state.previewAnimation);

        return {
          connectionStatus: nextConnectionStatus,
          jobs: updated,
          jobPreviewFrames: nextPreviewFrames,
          previewAnimation: null,
          activeJobId: null,
        };
      });
    };

    const applyPostprocessResult = (
      jobId: string,
      result: {
        postprocessedPreview: GenerationJob["postprocessedPreview"];
        postprocessError: string | null;
        importedAssetIds?: string[];
      },
    ) => {
      set((state) => {
        const currentJob = state.jobs.get(jobId);
        if (!currentJob) return {};

        const previousPreviewUrl = currentJob.postprocessedPreview?.previewUrl;
        const nextPreviewUrl = result.postprocessedPreview?.previewUrl;
        if (previousPreviewUrl && previousPreviewUrl !== nextPreviewUrl) {
          URL.revokeObjectURL(previousPreviewUrl);
        }

        const updated = new Map(state.jobs);
        updated.set(jobId, {
          ...currentJob,
          postprocessedPreview: result.postprocessedPreview ?? null,
          postprocessError: result.postprocessError,
          importedAssetIds: result.importedAssetIds ?? currentJob.importedAssetIds,
        });
        return { jobs: updated };
      });
    };

    const runJobPostprocess = async (jobSnapshot: GenerationJob) => {
      const previewFrameFiles = jobSnapshot.usesSaveImageWebsocketOutputs
        ? get().jobPreviewFrames.get(jobSnapshot.id) ?? []
        : [];
      if (jobSnapshot.outputs.length === 0 && previewFrameFiles.length === 0) {
        set((state) => {
          if (!state.jobPreviewFrames.has(jobSnapshot.id)) return {};
          const nextPreviewFrames = new Map(state.jobPreviewFrames);
          nextPreviewFrames.delete(jobSnapshot.id);
          return { jobPreviewFrames: nextPreviewFrames };
        });
        return;
      }
      const generationMetadata: GeneratedCreationMetadata =
        jobSnapshot.generationMetadata ?? {
          source: "generated",
          workflowName: "Unknown Workflow",
          inputs: [],
        };

      set({
        pipelineStatus: {
          phase: "postprocessing",
          message: "Rendering generation",
          interruptible: false,
        },
      });

      try {
        const postprocessResult = await frontendPostprocess(
          jobSnapshot.outputs,
          {
            postprocessing: jobSnapshot.postprocessConfig,
            aspectRatioProcessing: jobSnapshot.aspectRatioProcessing,
            generationMetadata,
            previewFrameFiles,
            preparedMaskFile: jobSnapshot.preparedMaskFile,
          },
        );
        applyPostprocessResult(jobSnapshot.id, {
          postprocessedPreview: postprocessResult.postprocessedPreview,
          postprocessError: postprocessResult.postprocessError,
          importedAssetIds: postprocessResult.importedAssetIds,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Postprocessing failed unexpectedly";
        console.error("[Generation] Auto-import failed:", error);
        applyPostprocessResult(jobSnapshot.id, {
          postprocessedPreview: null,
          postprocessError: message,
        });
      } finally {
        set((state) => {
          const hasPreviewFrames = state.jobPreviewFrames.has(jobSnapshot.id);
          if (!hasPreviewFrames && state.pipelineStatus.phase !== "postprocessing") {
            return {};
          }

          const nextPreviewFrames = hasPreviewFrames
            ? new Map(state.jobPreviewFrames)
            : null;
          nextPreviewFrames?.delete(jobSnapshot.id);

          return {
            ...(nextPreviewFrames
              ? { jobPreviewFrames: nextPreviewFrames }
              : {}),
            ...(state.pipelineStatus.phase === "postprocessing"
              ? { pipelineStatus: IDLE_PIPELINE_STATUS }
              : {}),
          };
        });
      }
    };

    const completeJob = (
      promptId: string,
      outputsOverride?: GenerationJob["outputs"],
    ): GenerationJob | null => {
      const state = get();
      const currentJob = state.jobs.get(promptId);
      if (!currentJob) return null;

      const completedJob: GenerationJob = {
        ...currentJob,
        status: "completed",
        progress: 100,
        currentNode: null,
        completedAt: Date.now(),
        outputs: outputsOverride ?? currentJob.outputs,
      };

      const updated = new Map(state.jobs);
      updated.set(promptId, completedJob);
      revokePreviewAnimation(state.previewAnimation);
      set({
        jobs: updated,
        previewAnimation: null,
        ...(state.activeJobId === promptId ? { activeJobId: null } : {}),
      });

      return completedJob;
    };

    client.onEvent((event: ComfyUIEvent) => {
      const { jobs } = get();

      switch (event.type) {
        case "status": {
          if (get().connectionStatus !== "connected") {
            set((state) => ({
              connectionStatus: "connected",
              runtimeStatus: state.runtimeStatus
                ? {
                    ...state.runtimeStatus,
                    comfyui: {
                      ...state.runtimeStatus.comfyui,
                      status: "connected",
                      error: null,
                    },
                  }
                : state.runtimeStatus,
              runtimeStatusError: null,
            }));
            // Re-fetch workflows when ComfyUI (re)connects so inputs appear
            get().fetchWorkflows();
            get().requestEditorReconnect();
          }
          break;
        }

        case "progress": {
          const job = jobs.get(event.data.prompt_id);
          if (job) {
            const updated = new Map(jobs);
            updated.set(event.data.prompt_id, {
              ...job,
              status: "running",
              progress: Math.round((event.data.value / event.data.max) * 100),
              currentNode: event.data.node,
            });
            set({ jobs: updated, activeJobId: event.data.prompt_id });
          }
          break;
        }

        case "executing": {
          if (event.data.node === null) {
            // Execution finished for this prompt
            const job = jobs.get(event.data.prompt_id);
            if (job && job.status !== "error") {
              const promptId = event.data.prompt_id;

              void (async () => {
                try {
                  const finalOutputs =
                    await getHistoryOutputsWithRetry(promptId);
                  const completedJob = completeJob(
                    promptId,
                    finalOutputs.length > 0 ? finalOutputs : undefined,
                  );
                  if (completedJob) {
                    void runJobPostprocess(completedJob);
                  }
                } catch (err) {
                  console.error(
                    "[Generation] Failed to fetch history for completed job",
                    err,
                  );
                  // Fallback: complete the job with whatever incremental outputs were collected
                  const completedJob = completeJob(promptId);
                  if (completedJob) {
                    void runJobPostprocess(completedJob);
                  }
                }
              })();
            }
          } else {
            const job = jobs.get(event.data.prompt_id);
            if (job) {
              const updated = new Map(jobs);
              const updatedJob = {
                ...job,
                status: "running" as const,
                currentNode: event.data.node,
              };
              updated.set(event.data.prompt_id, updatedJob);
              set({ jobs: updated, activeJobId: event.data.prompt_id });
            }
          }
          break;
        }

        case "executed": {
          const job = jobs.get(event.data.prompt_id);
          if (job) {
            const newOutputs = parseNodeOutputItems(event.data.output);
            if (newOutputs.length === 0) break;

            const updated = new Map(jobs);
            updated.set(event.data.prompt_id, {
              ...job,
              outputs: [...job.outputs, ...newOutputs],
            });
            set({ jobs: updated });
          }
          break;
        }

        case "execution_error": {
          const job = jobs.get(event.data.prompt_id);
          if (job) {
            const updated = new Map(jobs);
            updated.set(event.data.prompt_id, {
              ...job,
              status: "error",
              error: event.data.exception_message,
              currentNode: event.data.node_id,
            });
            set((state) => {
              const nextPreviewFrames = new Map(state.jobPreviewFrames);
              nextPreviewFrames.delete(event.data.prompt_id);
              revokePreviewAnimation(state.previewAnimation);
              return {
                jobs: updated,
                jobPreviewFrames: nextPreviewFrames,
                previewAnimation: null,
              };
            });
          }
          break;
        }

        case "error": {
          // Proxy-level error: ComfyUI is unreachable
          console.warn("[Generation] Proxy error:", event.data.message);
          void get().refreshRuntimeStatus();
          failActiveJob(event.data.message, "error");
          break;
        }
      }
    });

    client.onPreview((preview: ComfyUIPreview) => {
      set((state) => {
        if (state.latestPreviewUrl) {
          URL.revokeObjectURL(state.latestPreviewUrl);
        }
        const nextPreviewUrl = URL.createObjectURL(preview.blob);

        // Build animation buffer update for VHS-style previews that include
        // frame metadata (frameIndex, totalFrames, frameRate). These arrive
        // during KSampler execution and cycle through the video frames so
        // the preview can loop.
        const isVhsFrame =
          typeof preview.frameIndex === "number" &&
          typeof preview.totalFrames === "number" &&
          preview.totalFrames > 0 &&
          typeof preview.frameRate === "number" &&
          preview.frameRate > 0;

        let nextAnimation: PreviewAnimation | null = null;
        if (isVhsFrame) {
          const totalFrames = preview.totalFrames as number;
          const frameIdx = preview.frameIndex as number;
          const frameRate = preview.frameRate as number;
          const existingAnimation =
            state.previewAnimation?.totalFrames === totalFrames
              ? state.previewAnimation
              : replacePreviewAnimation(state.previewAnimation, null);
          const frameUrls = existingAnimation
            ? existingAnimation.frameUrls.slice()
            : new Array<string | null>(totalFrames).fill(null);
          const oldUrl = frameUrls[frameIdx];
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          frameUrls[frameIdx] = URL.createObjectURL(preview.blob);
          nextAnimation = { frameUrls, frameRate, totalFrames };
        } else {
          nextAnimation = replacePreviewAnimation(state.previewAnimation, null);
        }

        const activeJobId = state.activeJobId;
        if (!activeJobId) {
          return {
            latestPreviewUrl: nextPreviewUrl,
            previewAnimation: nextAnimation,
          };
        }

        const activeJob = state.jobs.get(activeJobId);
        if (
          !activeJob ||
          (activeJob.status !== "queued" && activeJob.status !== "running")
        ) {
          return {
            latestPreviewUrl: nextPreviewUrl,
            previewAnimation: nextAnimation,
          };
        }
        const previewMode = activeJob.postprocessConfig?.mode ?? "auto";
        const shouldCollectPreviewFrames =
          previewMode === "auto" ||
          previewMode === "stitch_frames_with_audio";
        if (
          !shouldCollectPreviewFrames ||
          !activeJob.usesSaveImageWebsocketOutputs
        ) {
          return {
            latestPreviewUrl: nextPreviewUrl,
            previewAnimation: nextAnimation,
          };
        }

        // Only collect frames when the SaveImageWebsocket node is executing.
        // Other nodes (e.g. KSampler) also emit binary preview frames for
        // live progress, but those are low-quality denoising previews that
        // must not be included in the final output.
        const isFromSaveNode =
          activeJob.currentNode != null &&
          activeJob.saveImageWebsocketNodeIds?.has(activeJob.currentNode);
        if (!isFromSaveNode) {
          return {
            latestPreviewUrl: nextPreviewUrl,
            previewAnimation: nextAnimation,
          };
        }

        const existingFrames = state.jobPreviewFrames.get(activeJobId) ?? [];
        const nextFrames = new Map(state.jobPreviewFrames);
        const previewFrames = existingFrames.slice();
        const frameIndex = getPreviewFrameIndex(preview, existingFrames);
        const mimeType = preview.blob.type || "image/png";

        previewFrames[frameIndex] = new File(
          [preview.blob],
          `ws-preview-${activeJobId}-${frameIndex.toString().padStart(6, "0")}.${getPreviewFrameExtension(mimeType)}`,
          {
            type: mimeType,
            lastModified: Date.now(),
          },
        );
        nextFrames.set(activeJobId, previewFrames);

        return {
          latestPreviewUrl: nextPreviewUrl,
          previewAnimation: nextAnimation,
          jobPreviewFrames: nextFrames,
        };
      });
    });

    client.connect();
    set({ wsClient: client });

    // Track WS lifecycle: the proxy WS opens immediately, but we only
    // confirm "connected" once a real ComfyUI status event arrives.
    client.onConnectionChange((wsState) => {
      if (wsState === "connected") {
        void get().refreshRuntimeStatus();
        if (get().connectionStatus !== "connected") {
          set({ connectionStatus: "connecting" });
        }
      } else {
        set((state) => ({
          connectionStatus: "disconnected",
          runtimeStatus: state.runtimeStatus
            ? {
                ...state.runtimeStatus,
                comfyui: {
                  ...state.runtimeStatus.comfyui,
                  status: "disconnected",
                },
              }
            : state.runtimeStatus,
        }));
        void get().refreshRuntimeStatus();
      }
    });

    // Initial fetch of workflows
    get().fetchWorkflows();
  },

  disconnect: () => {
    const {
      wsClient,
      latestPreviewUrl,
      previewAnimation,
      jobs,
      preprocessAbortController,
      pipelineRunToken,
    } = get();
    preprocessAbortController?.abort();
    wsClient?.disconnect();
    if (latestPreviewUrl) URL.revokeObjectURL(latestPreviewUrl);
    revokePreviewAnimation(previewAnimation);
    for (const job of jobs.values()) {
      revokeJobPostprocessPreview(job);
    }
    set({
      wsClient: null,
      connectionStatus: "disconnected",
      runtimeStatus: null,
      runtimeStatusError: null,
      latestPreviewUrl: null,
      previewAnimation: null,
      jobPreviewFrames: new Map(),
      editorNeedsReconnect: false,
      pipelineStatus: IDLE_PIPELINE_STATUS,
      preprocessAbortController: null,
      pipelineRunToken: pipelineRunToken + 1,
      objectInfoSynced: false,
    });
  },

  updateComfyUrl: async (url: string) => {
    // Update the backend's runtime URL, then reconnect
    await comfyApi.updateConfig(url);
    get().disconnect();
    const runtimeStatus = await get().refreshRuntimeStatus();
    set((state) => ({
      comfyuiDirectUrl: runtimeStatus?.comfyui.url ?? url,
      editorNeedsReconnect: false,
      ...(runtimeStatus
        ? {
            runtimeStatus,
            runtimeStatusError: null,
            connectionStatus: connectionStatusFromRuntime(runtimeStatus),
          }
        : {
            runtimeStatus: state.runtimeStatus,
            runtimeStatusError: state.runtimeStatusError,
            connectionStatus: state.connectionStatus,
          }),
    }));
    get().connect();
  },

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

    set((state) => ({
      syncedWorkflow: workflow,
      syncedGraphData: graphData,
      workflowInputs: presented.inputs,
      hasInferredInputs: presented.hasInferredInputs,
      derivedMaskMappings: presented.derivedMaskMappings,
      workflowRuleWarnings,
      workflowLoadError: null,
      mediaInputs: pruneMediaInputs(state.mediaInputs, presented.inputs),
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

    const nextAvailable = upsertWorkflowOption(availableWorkflows, {
      id: TEMP_WORKFLOW_ID,
      name: TEMP_WORKFLOW_DISPLAY_NAME,
    });

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
      tempWorkflow: { workflow, graphData, inputs },
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

      // Append temp entry if one exists
      const workflows = tempWorkflow
        ? upsertWorkflowOption(mergedWorkflows, {
            id: TEMP_WORKFLOW_ID,
            name: TEMP_WORKFLOW_DISPLAY_NAME,
          })
        : removeWorkflowOption(mergedWorkflows, TEMP_WORKFLOW_ID);

      set({ availableWorkflows: workflows });

      const selectedExists =
        !!selectedWorkflowId &&
        workflows.some((wf) => wf.id === selectedWorkflowId);

      if (workflows.length > 0 && !selectedExists) {
        get().loadWorkflow(workflows[0].id);
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

  syncObjectInfo: async () => {
    if (get().connectionStatus !== "connected") return;
    try {
      console.info("[Generation] Syncing object_info from ComfyUI...");
      const result = await comfyApi.syncObjectInfo();
      const inputNodeMap = mergeInputNodeMap(result.input_node_map);
      set({ objectInfoSynced: true, inputNodeMap });
    } catch (err) {
      console.error("[Generation] Failed to sync object_info:", err);
    }
  },

  loadWorkflow: async (workflowId: string) => {
    const requestId = ++latestWorkflowLoadRequestId;
    const isStale = () => requestId !== latestWorkflowLoadRequestId;
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

    // Start loading
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
      let rules = activeWorkflowRules;
      let rulesSourceId = rulesWorkflowSourceId;
      let rulesWarnings = activeRulesWarnings;

      // 1. Resolve workflow graph + rules (in-memory temp or backend file)
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
        maskCropMode: (rules ?? EMPTY_WORKFLOW_RULES).mask_cropping.mode,
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

      // 2. Load into Iframe (if available) to convert to API format
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
        // Editor not ready yet.
        // We leave isWorkflowLoading = true.
        // The ComfyUIEditor component will initialize, see the syncedGraphData,
        // inject it, and THEN set isWorkflowLoading = false.
        deferred = !isTempWorkflow;
      }
    } catch (err) {
      console.error("[Generation] Failed to load workflow:", err);
      // On error, we must turn off loading so user isn't stuck
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

      // preparedMaskFile will be set from backend response (processed/cropped mask)

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
      const responseWarnings = Array.isArray(response.workflow_warnings)
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
      // Convert processed mask from base64 to File for postprocess ingestion.
      // The transport is intentionally singular today because one generation
      // run only ever produces one linked generation mask clip. If that
      // changes, this needs to become a per-output collection instead.
      let preparedMaskFile = findPreparedMaskFallback(
        slotValues,
        derivedMaskMappings,
        workflowInputs,
      );
      if (response.processed_mask_video) {
        const binaryStr = atob(response.processed_mask_video);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
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

      const newJob: GenerationJob = {
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

    const markActiveJobStopped = (
      errorMessage: string,
      nextConnectionStatus?: ComfyUIConnectionStatus,
    ) => {
      set((state) => {
        const activeJobId = state.activeJobId;
        if (!activeJobId) {
          return nextConnectionStatus
            ? { connectionStatus: nextConnectionStatus }
            : {};
        }

        const activeJob = state.jobs.get(activeJobId);
        if (
          !activeJob ||
          (activeJob.status !== "running" && activeJob.status !== "queued")
        ) {
          return nextConnectionStatus
            ? { connectionStatus: nextConnectionStatus }
            : {};
        }

        const updated = new Map(state.jobs);
        updated.set(activeJobId, {
          ...activeJob,
          status: "error",
          error: errorMessage,
          currentNode: null,
          completedAt: Date.now(),
        });
        const nextPreviewFrames = new Map(state.jobPreviewFrames);
        nextPreviewFrames.delete(activeJobId);
        revokePreviewAnimation(state.previewAnimation);

        return {
          jobs: updated,
          jobPreviewFrames: nextPreviewFrames,
          previewAnimation: null,
          activeJobId: null,
          ...(nextConnectionStatus
            ? { connectionStatus: nextConnectionStatus }
            : {}),
        };
      });
    };

    const activeJob = activeJobId ? jobs.get(activeJobId) : null;
    if (!isActiveGenerationJob(activeJob)) {
      return;
    }

    try {
      await comfyApi.interrupt();
      markActiveJobStopped("Generation cancelled by user");
    } catch (error) {
      const message =
        error instanceof Error
          ? `Cancel failed: ${error.message}`
          : "Cancel failed: ComfyUI is unreachable";
      markActiveJobStopped(message, "error");
    }
  },

  importOutput: async (jobId, outputIndex) => {
    const { jobs } = get();
    const job = jobs.get(jobId);
    if (!job || !job.outputs[outputIndex]) return;

    const output = job.outputs[outputIndex];
    const file = await comfyApi.fetchOutputAsFile(
      output.filename,
      output.subfolder,
      output.type,
    );

    const { addLocalAsset } = await import("../userAssets");
    await addLocalAsset(file);
  },

  clearJob: (jobId) => {
    const { jobs } = get();
    revokeJobPostprocessPreview(jobs.get(jobId));
    const updated = new Map(jobs);
    updated.delete(jobId);
    set((state) => {
      const nextPreviewFrames = new Map(state.jobPreviewFrames);
      nextPreviewFrames.delete(jobId);
      return { jobs: updated, jobPreviewFrames: nextPreviewFrames };
    });
  },
}));
