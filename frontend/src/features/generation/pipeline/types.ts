import type {
  AspectRatioProcessingMetadata,
  GenerationJobOutput,
  GenerationPostprocessedPreview,
  WorkflowInput,
  WorkflowMaskCroppingMode,
  WorkflowPostprocessingConfig,
} from "../types";
import type {
  AssetFamilyCompatibility,
  GeneratedCreationMetadata,
} from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import type { GenerationAspectRatioSelection } from "../utils/aspectRatioSelection";

// ---------------------------------------------------------------------------
// Derived mask metadata
// ---------------------------------------------------------------------------

export type DerivedMaskType = "binary" | "soft";
export type DerivedMaskPurpose = "video" | "audio_timing";
export type TimelineSelectionRenderMode =
  | "input_selection"
  | "full_selection";
export type DerivedMaskSourceVideoTreatment =
  | "preserve_transparency"
  | "remove_transparency";

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
  /** Which selection variant to use when rendering the source video. */
  sourceSelection?: TimelineSelectionRenderMode;
  /** Which selection variant to use when rendering the derived mask. */
  maskSelection?: TimelineSelectionRenderMode;
  /** How the source video should be rendered when a derived mask is present. */
  sourceVideoTreatment?: DerivedMaskSourceVideoTreatment;
  /**
   * When true, the mask node is declared optional in the rules sidecar
   * (`present.required === false`). Optional uploads are decided from the
   * rendered mask output rather than structural clip inspection, so active
   * ranges and final scene compositing can suppress the upload and allow the
   * workflow's `input_presence` rewrite to bypass the mask chain.
   */
  optional?: boolean;
}

// ---------------------------------------------------------------------------
// Slot values — the raw input values collected from the UI, keyed by workflow
// input ID (or synthetic slot ID for manual slots).
// ---------------------------------------------------------------------------

export type SlotValue =
  | { type: "text"; value: string }
  | { type: "image"; file: File }
  | { type: "audio"; file: File }
  | {
      type: "video";
      file: File;
      // Source asset id for direct uploads. Lets collectVideoInputs render a
      // transparency-derived mask via renderAssetToMaskMp4 when this slot
      // also has derived mask mappings.
      assetId?: string;
      // Per-item audio inclusion for a batch reference video.
      includeEmbeddedAudio?: boolean;
    }
  | {
      type: "video_selection";
      selection: TimelineSelection;
      preparedVideoFile?: File;
      preparedMaskFile?: File;
      preparedDerivedMaskSignature?: string | null;
      // When set, the slot was queued while an extraction with this id was
      // still in flight. The dispatcher waits for the matching mediaInputs
      // entry to finish extracting before proceeding to preprocess.
      pendingExtractionRequestId?: number;
      // Per-item audio inclusion for a batch reference video.
      includeEmbeddedAudio?: boolean;
    };

/**
 * Per-item switches that travel with one batch upload, keyed by the same
 * request key as the media part itself (`getNodeInputRequestKeyForSlot`).
 * Keying them that way is what lets the backend build the loader's ordered
 * flag list from the very same index map it compacts the media with, so the
 * two lists cannot drift apart.
 */
export interface BatchInputOptions {
  include_audio?: boolean;
}

export interface TimelineSelectionInputMetadata {
  startTick: number;
  endTick: number;
  durationTicks: number;
  durationSeconds: number;
  effectiveFps: number;
  frameStep: number;
  frameOffset: number;
  frameCount: number;
  clipCount: number;
  trackCount: number;
  includedTrackCount: number;
  hasMaskClip: boolean;
  isRange: boolean;
}

export interface WorkflowInputMetadata {
  sourceKind: "asset" | "frame" | "timeline_selection";
  inputType: WorkflowInput["inputType"];
  mediaType?: "image" | "video" | "audio";
  timelineSelection?: TimelineSelectionInputMetadata;
}

export type WorkflowInputMetadataMap = Record<string, WorkflowInputMetadata>;

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
  /**
   * Short edge in pixels. Only a fallback here: a timeline selection carries
   * the resolution it was created with, and that wins.
   */
  outputResolution?: number;
}

export interface GenerationWorkflowSnapshot {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  // The exact workflow payload to POST to the backend. Always produced by
  // ComfyUI's `app.graphToPrompt()` on the bridge's temporary graph clone at
  // submission time, never by buildWorkflowFromGraphData. `null` only until
  // the submission step has captured it.
  submittedWorkflow?: Record<string, unknown> | null;
  // True when `submittedWorkflow` is graphToPrompt output from the frontend
  // pre-resolution transaction. Drives the backend's `prompt_is_pre_resolved`
  // flag so the backend treats the prompt as topology-final.
  promptIsPreResolved?: boolean;
}

export interface GenerationPreprocessPlan {
  slotValues: Record<string, SlotValue>;
  derivedMaskMappings: DerivedMaskMapping[];
  projectConfig: ProjectConfig;
  exactAspectRatio: boolean;
  /** The panel's aspect ratio choice; see {@link FrontendPreprocessOptions}. */
  aspectRatioSelection: GenerationAspectRatioSelection;
  targetResolution: number;
  maskCropDilation: number;
  maskCropMode: WorkflowMaskCroppingMode;
}

export interface GenerationSubmissionPlan {
  widgetInputs: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  inputMetadata: WorkflowInputMetadataMap;
  derivedWidgetInputs: Record<string, string>;
  widgetModes: Record<string, "fixed" | "randomize">;
  bypassNodeIds: string[];
  /** Nodes shipping `mode: 4` that this submission turns on. */
  activateNodeIds: string[];
  /** Contributions captured once, at submission time. Never re-invoked. */
  contributedEffects: readonly GenerationContributedEffectGroup[];
}

export interface GenerationMetadataPlan {
  generationMetadata: GeneratedCreationMetadata;
  workflowWarnings: WorkflowRuleWarning[];
}

export interface GenerationPostprocessPlan {
  config: WorkflowPostprocessingConfig;
}

// ---------------------------------------------------------------------------
// Normalized graph effects — the closed union defined in
// docs/generation-native-extension-seams-plan.md §3.3. Native rule rewrites
// and any later contributor converge on this model before prompt conversion.
// Do not generalize it to arbitrary graph patches: every new effect kind must
// name its invariant, conflict rule, validation owner, and queue
// serialization.
// ---------------------------------------------------------------------------

export type GenerationEffectJsonValue =
  | string
  | number
  | boolean
  | null
  | GenerationEffectJsonValue[]
  | { [key: string]: GenerationEffectJsonValue };

export interface GenerationWidgetTarget {
  readonly nodeId: string;
  readonly widget: string;
}

/**
 * Attribution for one contributor, carried inside the source string itself.
 *
 * A separate field would be droppable — a producer could appear with a source
 * and no attribution — and the string form keeps every existing diagnostic
 * message correct without a second interpolation branch. The id is the
 * registry's canonical `<extensionId>/<contributionId>`.
 */
export type GenerationExtensionEffectSource = `extension:${string}`;

/** Where a normalized effect originated, for diagnostics and attribution. */
export type GenerationEffectSource =
  | "panel-bypass"
  | "rule-default-override"
  | "rule-rewrite"
  | "rule-effect-switch"
  | GenerationExtensionEffectSource;

export type GenerationGraphEffect =
  | {
      readonly kind: "bypass-nodes";
      readonly nodeIds: readonly string[];
      readonly source: GenerationEffectSource;
    }
  | {
      /** Clear a node's shipped `mode: 4` for this submission. */
      readonly kind: "activate-nodes";
      readonly nodeIds: readonly string[];
      readonly source: GenerationEffectSource;
    }
  | {
      readonly kind: "set-widget";
      readonly target: GenerationWidgetTarget;
      readonly value: GenerationEffectJsonValue;
      readonly source: GenerationEffectSource;
    };

export interface GenerationEffectDiagnostic {
  readonly severity: "error" | "warning";
  readonly code:
    | "invalid-target"
    | "invalid-value"
    | "widget-collision"
    /** One node was asked to be both bypassed and activated. */
    | "node-mode-collision"
    /** A submission contributor threw, or could not be run at all. */
    | "contributor-failed";
  readonly source: GenerationEffectSource;
  readonly message: string;
}

/**
 * One contributor's validated contribution, captured into the plan at
 * submission time (docs/generation-extension-surface-plan.md E2).
 *
 * Plan data, not a live call: dispatch replays this instead of asking the
 * contributor again, so a queued generation is unaffected by later UI
 * changes, a workflow switch, or the extension being disabled. Diagnostics
 * travel with it for the same reason — a contribution that failed validation
 * must keep failing the submission on replay.
 */
export interface GenerationContributedWidgetOverride {
  readonly node_id: string;
  readonly widget: string;
  readonly value: GenerationEffectJsonValue;
}

/**
 * The workflow a contribution was planned and validated against.
 *
 * Without it a contribution is just a set of node ids, and node ids are only
 * unique within one workflow: a session publication arriving late, or a
 * workflow switched between collection and plan build, could otherwise place
 * effects validated against workflow A into a plan for workflow B and have the
 * bridge apply them because the ids happen to exist there too.
 */
export interface GenerationContributionWorkflowIdentity {
  readonly sourceId: string | null;
  readonly instanceId: string | null;
  readonly fingerprint: string;
}

export interface GenerationContributedEffectGroup {
  readonly source: GenerationExtensionEffectSource;
  readonly workflow: GenerationContributionWorkflowIdentity;
  readonly bypassNodeIds: readonly string[];
  readonly activateNodeIds?: readonly string[];
  readonly widgetOverrides: readonly GenerationContributedWidgetOverride[];
  readonly diagnostics: readonly GenerationEffectDiagnostic[];
}

/** Bridge identity a capture was resolved against (see BridgeWorkflowExpectation). */
export interface GenerationWorkflowExpectation {
  readonly workflowInstanceId: string;
  readonly revision: number;
}

/**
 * The effect record a prompt was resolved from. Prompt conversion consumes
 * only such a record, and it is evaluated from detached plan data plus the
 * dispatch's prepared request — never from live execution or editor state.
 *
 * The expectation pins the workflow the effects were resolved against so the
 * bridge rejects a switched or reloaded workflow before any GPU-bound work
 * starts.
 */
export interface GenerationCapturedEffects {
  readonly schemaVersion: 1;
  readonly expectation: GenerationWorkflowExpectation | null;
  readonly effects: readonly GenerationGraphEffect[];
  readonly diagnostics: readonly GenerationEffectDiagnostic[];
}

export interface GenerationPlan {
  id: string;
  createdAt: number;
  workflow: GenerationWorkflowSnapshot;
  preprocess: GenerationPreprocessPlan;
  submission: GenerationSubmissionPlan;
  metadata: GenerationMetadataPlan;
  postprocess: GenerationPostprocessPlan;
  /**
   * Normalized graph effects for this plan. `null` until captured. Queued
   * generations capture at enqueue time — which pins the workflow identity a
   * deferred dispatch must resolve against — and dispatch re-evaluates the
   * effects themselves once preprocessing has run; immediate submissions
   * capture during dispatch, before prompt conversion.
   */
  effects: GenerationCapturedEffects | null;
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
  /**
   * The aspect ratio the panel pinned, or `null` to probe the supplied media
   * (the "Auto" choice).
   */
  readonly requestedAspectRatio: string | null;
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
  batchInputOptions: Record<string, BatchInputOptions>;
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
  batchInputOptions?: Record<string, BatchInputOptions>;
  cachedMediaInputs?: Record<string, Record<string, unknown>>;
  maskCropMode?: WorkflowMaskCroppingMode;
  maskCropDilation?: number;
  widgetInputs?: Record<string, string>;
  derivedWidgetInputs?: Record<string, string>;
  widgetModes?: Record<string, "fixed" | "randomize">;
  inputMetadata?: WorkflowInputMetadataMap;
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
  saveImageWebsocketNodeIds: string[];
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
  /**
   * The panel's aspect ratio selector value: `"auto"` (probe the media, else
   * the project ratio) or a pinned `"<w>:<h>"` ratio. Defaults to `"auto"`.
   */
  aspectRatioSelection?: GenerationAspectRatioSelection;
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
