import type { Asset } from "../../../types/Asset";
import type { RuntimeStatus } from "../../../types/RuntimeStatus";
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
  WorkflowLoadState,
  WorkflowMaskCroppingMode,
} from "../types";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";

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
}

export interface GenerationWorkflowState {
  syncedWorkflow: Record<string, unknown> | null;
  syncedGraphData: Record<string, unknown> | null;
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
  setTargetResolution: (resolution: number) => void;
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
  setMediaInputAsset: (inputId: string, asset: Asset) => void;
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
  clearMediaInput: (inputId: string) => void;
  syncWorkflow: (
    workflow: Record<string, unknown> | null,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
    options?: { markReady?: boolean },
  ) => void;
  registerWorkflowFromEditor: (
    workflow: Record<string, unknown> | null,
    graphData: Record<string, unknown>,
    inputs: WorkflowInput[],
    filename: string | null,
  ) => Promise<void>;
  fetchWorkflows: () => Promise<void>;
  loadWorkflow: (filename: string) => Promise<void>;
  loadWorkflowFromAssetMetadata: (asset: Asset) => Promise<void>;
}

export interface GenerationRuntimeState {
  connectionStatus: ComfyUIConnectionStatus;
  runtimeStatus: RuntimeStatus | null;
  runtimeStatusError: string | null;
  comfyuiDirectUrl: string | null;
  wsClient: ComfyUIWebSocket | null;
  deliveryClient: GenerationDeliveryWebSocket | null;
  deliveryConnectionStatus: ComfyUIConnectionStatus;
  objectInfoSynced: boolean;
  rawObjectInfo: Record<string, unknown> | null;
  inputNodeMap: import("../constants/inputNodeMap").InputNodeMap | null;
  editorNeedsReconnect: boolean;
  editorReconnectSignal: number;
  setEditorNeedsReconnect: (required: boolean) => void;
  requestEditorReconnect: () => void;
  connect: () => void;
  disconnect: () => void;
  refreshRuntimeStatus: () => Promise<RuntimeStatus | null>;
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
  ) => Promise<string | null>;
  queueGeneration: (
    slotValues: Record<string, SlotValue>,
    widgetInputs?: Record<string, string>,
    widgetModes?: Record<string, "fixed" | "randomize">,
    derivedWidgetInputs?: Record<string, string>,
    count?: number,
    frontendStateWidgetValues?: Record<string, unknown>,
    bypassNodeIds?: string[],
  ) => Promise<void>;
  processGenerationQueue: () => Promise<void>;
  clearGenerationQueue: () => void;
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
