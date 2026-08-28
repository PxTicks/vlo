import type { Asset } from "../../../types/Asset";
import type {
  RuntimeSettingsPatch,
  RuntimeStatus,
} from "../../../types/RuntimeStatus";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  DerivedMaskMapping,
  GenerationPlan,
  SlotValue,
} from "../pipeline/types";
import type { ComfyUIWebSocket } from "../services/ComfyUIWebSocket";
import type { GenerationDeliveryWebSocket } from "../services/GenerationDeliveryWebSocket";
import type { WorkflowWarningSummary } from "../services/workflowBridge";
import type {
  GenerationJob,
  GenerationMediaInputValue,
  GenerationPipelineStatus,
  WorkflowInput,
  WorkflowInputItemOption,
  WorkflowLoadState,
  WorkflowMaskCroppingMode,
} from "../types";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import type { GenerationAspectRatioSelection } from "../utils/aspectRatioSelection";

export type ComfyUIConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface TempWorkflow {
  // `null` until graphToPrompt has produced an API workflow for this temp
  // tab; in that window only `graphData` is authoritative.
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown>;
  inputs: WorkflowInput[];
  name?: string;
  rules?: WorkflowRules | null;
  rulesSourceId?: string | null;
  rulesWarnings?: WorkflowRuleWarning[];
}

export interface WorkflowOption {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  groupOrder?: number;
}

export interface PreviewAnimation {
  frameUrls: (string | null)[];
  frameRate: number;
  totalFrames: number;
}

export interface WorkflowReplayPanelState {
  textValues: Record<string, string>;
  widgetValues: Record<string, string>;
  widgetModes: Record<string, "fixed" | "randomize">;
  derivedWidgetValues: Record<string, string>;
  bypassNodeIds?: string[];
  activateNodeIds?: string[];
}

export interface GenerationWorkflowState {
  syncedWorkflow: Record<string, unknown> | null;
  syncedGraphData: Record<string, unknown> | null;
  iframeWorkflowInstanceId: string | null;
  iframeWorkflowRevision: number | null;
  workflowInputs: WorkflowInput[];
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
  /**
   * How many consecutive editor reads have shown a rule loss that looks
   * suspect — same workflow identity, but stages/nodes/derived widgets that
   * existed in the cached rules are missing from the freshly resolved ones.
   *
   * Used by `registerWorkflowFromEditor` to delay destructive rule
   * replacement until a second confirming read, so a transient partial
   * `activeState` read from the iframe (e.g. ComfyUI mid-update during a
   * model change/close) cannot strand the panel with empty rules.
   */
  suspectRuleLossCount: number;
  derivedMaskMappings: DerivedMaskMapping[];
  maskCropMode: WorkflowMaskCroppingMode;
  targetResolution: number;
  /**
   * The user typed a short edge off the workflow's ladder. Loading a workflow
   * leaves a custom value alone rather than snapping it back to a rung.
   */
  targetResolutionIsCustom: boolean;
  setTargetResolution: (resolution: number, isCustom?: boolean) => void;
  /**
   * The panel's aspect ratio choice: `"auto"` (the default — probe the supplied
   * media, else the project ratio), or a pinned `"<w>:<h>"` ratio.
   */
  aspectRatioSelection: GenerationAspectRatioSelection;
  setAspectRatioSelection: (selection: GenerationAspectRatioSelection) => void;
  preResolvedPromptEnabled: boolean;
  setPreResolvedPromptEnabled: (enabled: boolean) => void;
  exactAspectRatio: boolean;
  setExactAspectRatio: (exact: boolean) => void;
  setMaskCropMode: (mode: WorkflowMaskCroppingMode) => void;
  maskCropDilation: number;
  setMaskCropDilation: (dilation: number) => void;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  pendingReplayPanelState: WorkflowReplayPanelState | null;
  setPendingReplayPanelState: (state: WorkflowReplayPanelState | null) => void;
  clearPendingReplayPanelState: () => void;
  editorRef: HTMLIFrameElement | null;
  registerEditor: (iframe: HTMLIFrameElement) => void;
  unregisterEditor: () => void;
  setWorkflowLoading: (loading: boolean) => void;
  setWorkflowLoadState: (state: WorkflowLoadState) => void;
  clearWorkflowWarning: () => void;
  clearWorkflowLoadError: () => void;
  clearWorkflowSelection: () => void;
  setMediaInputAsset: (
    inputId: string,
    asset: Asset,
    options?: {
      isExtracting?: boolean;
      extractionRequestId?: number;
      extractedAudioFile?: File | null;
      extractionError?: string | null;
    },
  ) => void;
  setMediaInputFrame: (inputId: string, file: File) => void;
  setMediaInputFrameWithSelection: (
    inputId: string,
    file: File,
    timelineSelection: TimelineSelection,
  ) => void;
  setMediaInputTimelineSelection: (
    inputId: string,
    timelineSelection: TimelineSelection,
    thumbnailFile: File,
    options?: {
      mediaType?: "video" | "audio";
      isExtracting?: boolean;
      extractionRequestId?: number;
      preparedVideoFile?: File | null;
      preparedAudioFile?: File | null;
      preparedMaskFile?: File | null;
      preparedDerivedMaskSignature?: string | null;
      extractionError?: string | null;
    },
  ) => void;
  reassignMediaInput: (sourceInputId: string, targetInputId: string) => void;
  /**
   * Moves one batch item to `targetIndex` within its repeatable input, closing
   * the gap behind it. Delivery order is slot order, so this is what reordering
   * a batch strip means downstream.
   */
  moveMediaInput: (sourceInputId: string, targetIndex: number) => void;
  setMediaInputItemOption: (
    inputId: string,
    option: WorkflowInputItemOption,
    active: boolean,
  ) => void;
  clearMediaInput: (inputId: string) => void;
  syncWorkflow: (
    workflow: Record<string, unknown> | null,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
    options?: {
      markReady?: boolean;
      bridgeIdentity?: { workflowInstanceId: string; revision: number } | null;
    },
  ) => void;
  registerWorkflowFromEditor: (
    workflow: Record<string, unknown> | null,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
    filename: string | null,
    bridgeIdentity?: { workflowInstanceId: string; revision: number } | null,
  ) => Promise<void>;
  fetchWorkflows: () => Promise<void>;
  loadWorkflow: (filename: string) => Promise<void>;
  loadWorkflowFromAssetMetadata: (asset: Asset) => Promise<void>;
  /** Re-run ComfyUI's missing-model pipeline in the iframe (after model
   * downloads land on disk) and refresh `workflowWarning` from the new
   * pendingWarnings. Cheap compared to loadWorkflow. Returns `true` when
   * the iframe call ran (regardless of whether warnings still remain);
   * callers can fall back to a full workflow reload on `false`. */
  refreshMissingModelsFromIframe: () => Promise<boolean>;
}

export interface GenerationRuntimeState {
  connectionStatus: ComfyUIConnectionStatus;
  runtimeStatus: RuntimeStatus | null;
  runtimeStatusError: string | null;
  /**
   * Total items in ComfyUI's single global queue (running + pending) across
   * every client, from the broadcast `status` event. vlo submits serially so it
   * keeps at most one job in that queue; a value above vlo's own in-flight count
   * means the editor iframe (or another client) is also using ComfyUI. `null`
   * until the first status frame. */
  comfyQueueRemaining: number | null;
  comfyuiDirectUrl: string | null;
  wsClient: ComfyUIWebSocket | null;
  deliveryClient: GenerationDeliveryWebSocket | null;
  deliveryConnectionStatus: ComfyUIConnectionStatus;
  objectInfoSynced: boolean;
  rawObjectInfo: Record<string, unknown> | null;
  inputNodeMap: import("../constants/inputNodeMap").InputNodeMap | null;
  editorNeedsReconnect: boolean;
  editorReconnectSignal: number;
  /** Whether the fullscreen ComfyUI editor overlay is showing. Store-owned so
   * surfaces outside the generation panel (e.g. the left sidebar's asset
   * browser, which must not double-mount) can react to it. */
  editorOpen: boolean;
  setEditorOpen: (open: boolean) => void;
  setEditorNeedsReconnect: (required: boolean) => void;
  requestEditorReconnect: () => void;
  connect: () => void;
  disconnect: () => void;
  refreshRuntimeStatus: () => Promise<RuntimeStatus | null>;
  updateRuntimeSettings: (patch: RuntimeSettingsPatch) => Promise<void>;
  updateComfyUrl: (url: string) => Promise<void>;
  syncObjectInfo: () => Promise<void>;
}

export interface GenerationJobState {
  jobs: Map<string, GenerationJob>;
  jobPreviewFrames: Map<string, File[]>;
  activeJobId: string | null;
  latestPreviewUrl: string | null;
  previewAnimation: PreviewAnimation | null;
  importOutput: (jobId: string, outputIndex: number) => Promise<void>;
  clearJob: (jobId: string) => void;
}

export interface GenerationExecutionState {
  pipelineStatus: GenerationPipelineStatus;
  pipelineRunToken: number;
  preprocessAbortController: AbortController | null;
  lastAppliedWidgetValues: Record<string, string>;
  generationQueue: GenerationPlan[];
  postprocessingJobIds: string[];
  submitGeneration: (
    slotValues: Record<string, SlotValue>,
    widgetInputs?: Record<string, string>,
    widgetModes?: Record<string, "fixed" | "randomize">,
    derivedWidgetInputs?: Record<string, string>,
    frontendStateWidgetValues?: Record<string, unknown>,
    bypassNodeIds?: string[],
    activateNodeIds?: string[],
  ) => Promise<string | null>;
  queueGeneration: (
    slotValues: Record<string, SlotValue>,
    widgetInputs?: Record<string, string>,
    widgetModes?: Record<string, "fixed" | "randomize">,
    derivedWidgetInputs?: Record<string, string>,
    count?: number,
    frontendStateWidgetValues?: Record<string, unknown>,
    bypassNodeIds?: string[],
    activateNodeIds?: string[],
  ) => Promise<void>;
  processGenerationQueue: () => Promise<void>;
  /**
   * Lift the hold taken when the backend refused GPU admission, and resume.
   * Driven by the model-work ledger, which is owned by the editor lifecycle
   * rather than by this store.
   */
  resumeGenerationQueueAfterGpuRelease: () => void;
  /**
   * Drop every generation that has not started: plans still awaiting local
   * preprocessing, and the prompts already sitting in ComfyUI's queue. Leaves
   * the running prompt alone.
   */
  clearGenerationQueue: () => Promise<void>;
  /** Remove one not-yet-started prompt from ComfyUI's queue. */
  cancelQueuedGeneration: (promptId: string) => Promise<void>;
  interruptCurrentGeneration: () => Promise<void>;
  cancelGeneration: () => Promise<void>;
}

export type GenerationStore = GenerationRuntimeState &
  GenerationWorkflowState &
  GenerationJobState &
  GenerationExecutionState;

export type GenerationStorePatch = Partial<GenerationStore>;

export type GenerationStoreSet = (
  partial:
    | GenerationStorePatch
    | ((state: GenerationStore) => GenerationStorePatch),
) => void;

export type GenerationStoreGet = () => GenerationStore;

export interface PostprocessResultPatch {
  postprocessedPreview: GenerationJob["postprocessedPreview"];
  postprocessError: string | null;
  importedAssetIds?: string[];
}
