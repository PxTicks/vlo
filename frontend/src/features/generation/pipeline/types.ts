import type {
  AspectRatioProcessingMetadata,
  GenerationJobOutput,
  GenerationPostprocessedPreview,
  WorkflowInput,
  WorkflowMaskCroppingMode,
  WorkflowPostprocessingConfig,
} from "../types";
import type { DerivedMaskSourceVideoTreatment } from "../derivedMaskVideoTreatment";
import type {
  AssetFamilyCompatibility,
  GeneratedCreationMetadata,
} from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";

// ---------------------------------------------------------------------------
// Derived mask metadata
// ---------------------------------------------------------------------------

export type DerivedMaskType = "binary" | "soft";
export type DerivedMaskPurpose = "video" | "audio_timing";

export interface DerivedMaskMapping {
  /** Node ID of the mask input (the one that receives the rendered mask) */
  maskNodeId: string;
  /** Parameter name on the mask node (e.g. "file") */
  maskParam: string;
  /** Node ID of the source video input that the mask is derived from */
  sourceNodeId: string;
  /** Stable input ID for the source video input when it can be resolved. */
  sourceInputId?: string;
  /** The type of mask transform to apply during rendering */
  maskType: DerivedMaskType;
  /** How the rendered mask will be used by the workflow. */
  purpose?: DerivedMaskPurpose;
  /** Optional export FPS override for temporal/audio timing masks. */
  renderFps?: number;
}

// ---------------------------------------------------------------------------
// Slot values — the raw input values collected from the UI, keyed by workflow
// input ID (or synthetic slot ID for manual slots).
// ---------------------------------------------------------------------------

export type SlotValue =
  | { type: "text"; value: string }
  | { type: "image" | "video" | "audio"; file: File }
  | {
      type: "video_selection";
      selection: TimelineSelection;
      preparedVideoFile?: File;
      preparedMaskFile?: File;
      derivedMaskVideoTreatment?: DerivedMaskSourceVideoTreatment;
      preparedDerivedMaskVideoTreatment?: DerivedMaskSourceVideoTreatment;
    };

// ---------------------------------------------------------------------------
// Processor metadata — self-documenting processor declarations
// ---------------------------------------------------------------------------

export interface ProcessorMeta {
  /** Unique processor name, e.g. "collectTextInputs" */
  name: string;
  /** Context fields this processor reads */
  reads: readonly string[];
  /** Context fields this processor writes or mutates */
  writes: readonly string[];
  /** Human-readable description of what this processor does */
  description: string;
}

export interface Processor<TContext> {
  meta: ProcessorMeta;
  /** Returns true if this processor should run given the current context. */
  isActive(ctx: TContext): boolean;
  /** Executes the processor, reading from and writing to the context. */
  execute(ctx: TContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Processor description — output of describeActiveProcessors()
// ---------------------------------------------------------------------------

export interface ProcessorDescription {
  name: string;
  description: string;
  reads: readonly string[];
  writes: readonly string[];
  active: boolean;
}

// ---------------------------------------------------------------------------
// Frontend Preprocess Context
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  fps: number;
  aspectRatio: string;
}

export interface GenerationWorkflowSnapshot {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  preResolvedWorkflow?: Record<string, unknown> | null;
}

export interface GenerationPreprocessPlan {
  slotValues: Record<string, SlotValue>;
  derivedMaskMappings: DerivedMaskMapping[];
  projectConfig: ProjectConfig;
  exactAspectRatio: boolean;
  targetResolution: number;
  maskCropDilation: number;
  maskCropMode: WorkflowMaskCroppingMode;
}

export interface GenerationSubmissionPlan {
  widgetInputs: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  derivedWidgetInputs: Record<string, string>;
  widgetModes: Record<string, "fixed" | "randomize">;
}

export interface GenerationMetadataPlan {
  generationMetadata: GeneratedCreationMetadata;
  workflowWarnings: WorkflowRuleWarning[];
}

export interface GenerationPostprocessPlan {
  config: WorkflowPostprocessingConfig;
}

export interface GenerationPlan {
  id: string;
  createdAt: number;
  workflow: GenerationWorkflowSnapshot;
  preprocess: GenerationPreprocessPlan;
  submission: GenerationSubmissionPlan;
  metadata: GenerationMetadataPlan;
  postprocess: GenerationPostprocessPlan;
}

export interface FrontendPreprocessContext {
  // --- Inputs (populated before the runner starts) ---
  readonly syncedWorkflow: Record<string, unknown> | null;
  readonly syncedGraphData: Record<string, unknown> | null;
  readonly workflowId: string | null;
  readonly workflowRules: WorkflowRules | null;
  readonly workflowInputs: WorkflowInput[];
  readonly slotValues: Record<string, SlotValue>;
  readonly derivedMaskMappings: DerivedMaskMapping[];
  readonly projectConfig: ProjectConfig;
  readonly exactAspectRatio: boolean;
  readonly targetResolution: number;
  readonly clientId: string;
  readonly maskCropDilation: number | undefined;
  readonly maskCropMode: WorkflowMaskCroppingMode | undefined;
  readonly signal?: AbortSignal;

  // --- Accumulated outputs (processors write to these) ---
  targetAspectRatio: string;
  textInputs: Record<string, string>;
  imageInputs: Record<string, File>;
  audioInputs: Record<string, File>;
  videoInputs: Record<string, File>;
  pipelineInputs: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Frontend Preprocess Result (what the runner returns)
// ---------------------------------------------------------------------------

export interface GenerationRequest {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  projectId?: string;
  workflowRules?: WorkflowRules | null;
  deliveryContext?: GenerationDeliveryContext;
  exactAspectRatio: boolean;
  targetAspectRatio?: string;
  targetResolution?: number;
  textInputs: Record<string, string>;
  imageInputs: Record<string, File>;
  videoInputs: Record<string, File>;
  audioInputs: Record<string, File>;
  maskCropMode?: WorkflowMaskCroppingMode;
  maskCropDilation?: number;
  widgetInputs?: Record<string, string>;
  derivedWidgetInputs?: Record<string, string>;
  widgetModes?: Record<string, "fixed" | "randomize">;
  pipelineInputs: Record<string, Record<string, unknown>>;
  clientId: string;
  promptIsPreResolved?: boolean;
}

export interface PreparedGeneration {
  plan: GenerationPlan;
  request: GenerationRequest;
}

export interface GenerationDeliveryContext {
  planId: string;
  workflowName: string;
  workflowSourceId: string | null;
  generationMetadata: GeneratedCreationMetadata;
  postprocessConfig: WorkflowPostprocessingConfig;
  autoFamilyRequestKey: string | null;
  usesSaveImageWebsocketOutputs: boolean;
  replayInputs?: Record<string, unknown> | null;
}

export interface SubmittedGeneration {
  prepared: PreparedGeneration;
  promptId: string;
  deliveryId: string | null;
  responseWarnings: WorkflowRuleWarning[];
  appliedWidgetValues: Record<string, string>;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
  generationMetadata: GeneratedCreationMetadata;
  autoFamilyRequestKey: string | null;
  preparedMaskFile: File | null;
  usesSaveImageWebsocketOutputs: boolean;
  saveImageWebsocketNodeIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Frontend Postprocess Context
// ---------------------------------------------------------------------------

export interface FetchedFile {
  output: GenerationJobOutput;
  file: File;
}

export interface FrontendPostprocessContext {
  // --- Inputs (populated before the runner starts) ---
  readonly outputs: GenerationJobOutput[];
  readonly postprocessingConfig: WorkflowPostprocessingConfig;
  readonly aspectRatioProcessing: AspectRatioProcessingMetadata | null;
  generationMetadata: GeneratedCreationMetadata;
  readonly autoFamilyRequestKey: string | null;
  readonly previewFrameFiles: File[];
  preparedMaskFile: File | null;

  // --- Accumulated outputs (processors write to these) ---
  fetchedFiles: FetchedFile[];
  frameFiles: File[];
  audioFiles: File[];
  videoFiles: File[];
  packagedVideo: File | null;
  packagedVideoCompatibility: AssetFamilyCompatibility | null;
  stitchFailure: string | null;
  stitchMessage: string | null;
  importedAssetIds: string[];
  postprocessedPreview: GenerationPostprocessedPreview | null;
  postprocessError: string | null;
}

export interface FrontendPostprocessOptions {
  postprocessing?: WorkflowPostprocessingConfig | null;
  aspectRatioProcessing?: AspectRatioProcessingMetadata | null;
  generationMetadata: GeneratedCreationMetadata;
  autoFamilyRequestKey?: string | null;
  previewFrameFiles?: File[] | null;
  preparedMaskFile?: File | null;
}

export interface FrontendPreprocessOptions {
  signal?: AbortSignal;
  exactAspectRatio?: boolean;
  maskCropMode?: WorkflowMaskCroppingMode;
  targetResolution?: number;
  projectConfig?: ProjectConfig;
}

// ---------------------------------------------------------------------------
// Frontend Postprocess Result (what the runner returns)
// ---------------------------------------------------------------------------

export interface FrontendPostprocessResult {
  postprocessedPreview: GenerationPostprocessedPreview | null;
  postprocessError: string | null;
  importedAssetIds: string[];
}
