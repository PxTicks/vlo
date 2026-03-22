import type {
  AspectRatioProcessingMetadata,
  GenerationJobOutput,
  GenerationPostprocessedPreview,
  WorkflowInput,
  WorkflowMaskCroppingMode,
  WorkflowPostprocessingConfig,
} from "../types";
import type { DerivedMaskSourceVideoTreatment } from "../derivedMaskVideoTreatment";
import type { GeneratedCreationMetadata } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";

// ---------------------------------------------------------------------------
// Derived mask metadata
// ---------------------------------------------------------------------------

export type DerivedMaskType = "binary" | "soft";

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
}

// ---------------------------------------------------------------------------
// Slot values — the raw input values collected from the UI, keyed by workflow
// input ID (or synthetic slot ID for manual slots).
// ---------------------------------------------------------------------------

export type SlotValue =
  | { type: "text"; value: string }
  | { type: "image" | "video"; file: File }
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

export interface FrontendPreprocessContext {
  // --- Inputs (populated before the runner starts) ---
  readonly syncedWorkflow: Record<string, unknown> | null;
  readonly syncedGraphData: Record<string, unknown> | null;
  readonly workflowId: string | null;
  readonly workflowInputs: WorkflowInput[];
  readonly slotValues: Record<string, SlotValue>;
  readonly derivedMaskMappings: DerivedMaskMapping[];
  readonly projectConfig: ProjectConfig;
  readonly targetResolution: number;
  readonly clientId: string;
  readonly maskCropDilation: number | undefined;
  readonly maskCropMode: WorkflowMaskCroppingMode | undefined;
  readonly signal?: AbortSignal;

  // --- Accumulated outputs (processors write to these) ---
  textInputs: Record<string, string>;
  imageInputs: Record<string, File>;
  videoInputs: Record<string, File>;
}

// ---------------------------------------------------------------------------
// Frontend Preprocess Result (what the runner returns)
// ---------------------------------------------------------------------------

export interface GenerationRequest {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  targetAspectRatio: string;
  targetResolution: number;
  textInputs: Record<string, string>;
  imageInputs: Record<string, File>;
  videoInputs: Record<string, File>;
  widgetInputs?: Record<string, string>;
  derivedWidgetInputs?: Record<string, string>;
  widgetModes?: Record<string, "fixed" | "randomize">;
  maskCropDilation?: number;
  maskCropMode?: WorkflowMaskCroppingMode;
  clientId: string;
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
  readonly previewFrameFiles: File[];
  preparedMaskFile: File | null;

  // --- Accumulated outputs (processors write to these) ---
  fetchedFiles: FetchedFile[];
  frameFiles: File[];
  audioFiles: File[];
  videoFiles: File[];
  packagedVideo: File | null;
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
  previewFrameFiles?: File[] | null;
  preparedMaskFile?: File | null;
}

export interface FrontendPreprocessOptions {
  signal?: AbortSignal;
  maskCropMode?: WorkflowMaskCroppingMode;
  targetResolution?: number;
}

// ---------------------------------------------------------------------------
// Frontend Postprocess Result (what the runner returns)
// ---------------------------------------------------------------------------

export interface FrontendPostprocessResult {
  postprocessedPreview: GenerationPostprocessedPreview | null;
  postprocessError: string | null;
  importedAssetIds: string[];
}
