import type {
  Asset,
  AssetType,
  GeneratedCreationMetadata,
} from "../../types/Asset";
import type { TimelineSelection } from "../../types/TimelineTypes";
import type { DerivedMaskSourceVideoTreatment } from "./derivedMaskVideoTreatment";

export type GenerationMode = "image" | "video";
export type WorkflowLoadState = "idle" | "loading" | "ready" | "error";
export type GenerationPipelinePhase = "idle" | "preprocessing" | "postprocessing";

export interface GenerationPipelineStatus {
  phase: GenerationPipelinePhase;
  message: string | null;
  interruptible: boolean;
}

export type GenerationJobStatus = "queued" | "running" | "completed" | "error";

export type WorkflowPostprocessingMode =
  | "auto"
  | "stitch_frames_with_audio"
  | "none";
export type WorkflowPostprocessingPanelPreview =
  | "raw_outputs"
  | "replace_outputs";
export type WorkflowPostprocessingOnFailure = "fallback_raw" | "show_error";
export type WorkflowMaskCroppingMode = "crop" | "full";

export interface WorkflowPostprocessingConfig {
  mode: WorkflowPostprocessingMode;
  panel_preview: WorkflowPostprocessingPanelPreview;
  on_failure: WorkflowPostprocessingOnFailure;
  stitch_fps?: number;
}

export interface GenerationPostprocessedPreview {
  previewUrl: string;
  mediaKind: "image" | "video" | "audio";
  filename: string;
}

export interface GenerationJobOutput {
  filename: string;
  subfolder: string;
  type: string;
  viewUrl: string;
}

export interface AspectRatioProcessingRequested {
  aspect_ratio: string;
  resolution: number;
  width: number;
  height: number;
}

export interface AspectRatioProcessingParamRef {
  node_id: string;
  param: string;
}

export interface AspectRatioProcessingStrided {
  width: number;
  height: number;
  aspect_ratio: number;
  distortion: number;
  error: number;
  stride: number;
  search_steps: number;
}

export interface AspectRatioProcessingAppliedNode {
  node_id?: string;
  width_param?: string;
  height_param?: string;
  width?: AspectRatioProcessingParamRef;
  height?: AspectRatioProcessingParamRef;
}

export interface AspectRatioProcessingPostprocess {
  enabled: boolean;
  mode: "stretch_exact";
  apply_to: "all_visual_outputs";
  target_width: number;
  target_height: number;
}

export interface AspectRatioProcessingMetadata {
  enabled: boolean;
  requested: AspectRatioProcessingRequested;
  strided: AspectRatioProcessingStrided;
  applied_nodes: AspectRatioProcessingAppliedNode[];
  postprocess: AspectRatioProcessingPostprocess;
}

export type { MaskCropMetadata } from "../../types/Asset";

export interface GenerationJob {
  id: string;
  status: GenerationJobStatus;
  progress: number;
  currentNode: string | null;
  outputs: GenerationJobOutput[];
  error: string | null;
  submittedAt: number;
  completedAt: number | null;
  postprocessConfig?: WorkflowPostprocessingConfig;
  aspectRatioProcessing?: AspectRatioProcessingMetadata | null;
  generationMetadata?: GeneratedCreationMetadata;
  postprocessedPreview?: GenerationPostprocessedPreview | null;
  postprocessError?: string | null;
  autoFamilyRequestKey?: string | null;
  importedAssetIds?: string[];
  usesSaveImageWebsocketOutputs?: boolean;
  saveImageWebsocketNodeIds?: ReadonlySet<string>;
  preparedMaskFile?: File | null;
}

export interface WorkflowSelectionConfig {
  exportFps?: number;
  frameStep?: number;
  maxFrames?: number;
}

export interface WorkflowInputDispatch {
  kind: "node";
  selectionConfig?: WorkflowSelectionConfig;
}

export interface WorkflowInputPresentationGroup {
  id: string;
  title?: string;
  order?: number;
}

export interface WorkflowInputPresentation {
  group?: WorkflowInputPresentationGroup;
}

export interface InputSlot {
  id: string;
  accept: AssetType[];
  label: string;
  asset: Asset | null;
}

export interface WorkflowInput {
  id?: string;
  nodeId: string;
  classType: string;
  inputType: "text" | "image" | "video" | "audio";
  param: string;
  label: string;
  description?: string | null;
  currentValue: unknown;
  origin: "rule" | "inferred";
  dispatch?: WorkflowInputDispatch;
  presentation?: WorkflowInputPresentation;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
}

export interface GenerationAssetInputValue {
  kind: "asset";
  asset: Asset;
}

export interface GenerationFrameInputValue {
  kind: "frame";
  file: File;
  previewUrl: string;
  timelineSelection?: TimelineSelection | null;
}

interface BaseGenerationTimelineSelectionInputValue {
  kind: "timelineSelection";
  timelineSelection: TimelineSelection;
  thumbnailFile: File;
  thumbnailUrl: string;
  isExtracting: boolean;
  extractionRequestId: number;
  extractionError: string | null;
}

export interface GenerationAudioTimelineSelectionInputValue
  extends BaseGenerationTimelineSelectionInputValue {
  mediaType: "audio";
  preparedAudioFile: File | null;
}

export interface GenerationVideoTimelineSelectionInputValue
  extends BaseGenerationTimelineSelectionInputValue {
  mediaType: "video";
  preparedVideoFile: File | null;
  preparedMaskFile: File | null;
  preparedDerivedMaskVideoTreatment: DerivedMaskSourceVideoTreatment | null;
}

export type GenerationTimelineSelectionInputValue =
  | GenerationAudioTimelineSelectionInputValue
  | GenerationVideoTimelineSelectionInputValue;

export type GenerationMediaInputValue =
  | GenerationAssetInputValue
  | GenerationFrameInputValue
  | GenerationTimelineSelectionInputValue;

export type WidgetValueType =
  | "int"
  | "float"
  | "string"
  | "boolean"
  | "enum"
  | "unknown";

export type WidgetControlType = "slider";
export type WidgetSliderDisplay = "percent" | "number";

export interface WidgetInputConfig {
  label: string;
  controlAfterGenerate: boolean;
  defaultRandomize?: boolean;
  frontendOnly?: boolean;
  hidden?: boolean;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: unknown;
  sliderDisplay?: WidgetSliderDisplay;
  unit?: string;
  nodeTitle?: string;
  groupId?: string;
  groupTitle?: string;
  groupOrder?: number;
  control?: WidgetControlType;
  valueType?: WidgetValueType;
  options?: Array<string | number | boolean>;
  trueValue?: unknown;
  falseValue?: unknown;
}

export interface WorkflowParamReference {
  nodeId: string;
  param: string;
}

export interface RawWorkflowWidgetInput {
  kind?: "raw";
  nodeId: string;
  param: string;
  config: WidgetInputConfig;
  currentValue: unknown;
}

export interface WorkflowDualSamplerDenoiseSourceValues {
  totalSteps: number;
  startStep: number;
  baseSplitStep: number;
}

export interface DualSamplerDenoiseDerivedWidgetInput {
  kind: "derived";
  deriveKind: "dual_sampler_denoise";
  derivedWidgetId: string;
  nodeId: string;
  param: string;
  config: WidgetInputConfig;
  currentValue: number;
  sources: WorkflowDualSamplerDenoiseSourceValues;
}

export type VideoAudioRetakeMode = "Video & Audio" | "Video" | "Audio";

export interface VideoAudioRetakeSourceValues {
  videoBypass: boolean;
  audioBypass: boolean;
}

export interface VideoAudioRetakeDerivedWidgetInput {
  kind: "derived";
  deriveKind: "video_audio_retake";
  derivedWidgetId: string;
  nodeId: string;
  param: string;
  config: WidgetInputConfig;
  currentValue: VideoAudioRetakeMode;
  sources: VideoAudioRetakeSourceValues;
}

export type DerivedWorkflowWidgetInput =
  | DualSamplerDenoiseDerivedWidgetInput
  | VideoAudioRetakeDerivedWidgetInput;

export type WorkflowWidgetInput =
  | RawWorkflowWidgetInput
  | DerivedWorkflowWidgetInput;
