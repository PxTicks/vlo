import type { ClipTransform, TimelineSelection } from "./TimelineTypes";
import type { MiniEditorEditSpec } from "../features/miniEditor";

/** Serializable source and instructions for replaying a generation mini-editor save. */
export interface GeneratedMiniEditorEdit {
  assetId: string | null;
  /** Original detached selection, before the editor's crop and range masks. */
  timelineSelection?: TimelineSelection;
  spec: MiniEditorEditSpec;
  /** Pins the synthetic asset bake to the settings used when Save was pressed. */
  render?: { width: number; height: number; fps: number };
}

export type AssetType = "video" | "image" | "audio" | "lut";

export interface AssetFamilyCompatibility {
  assetType: AssetType;
  durationMs: number | null;
  fpsMilli: number | null;
}

export interface AssetFamily {
  id: string;
  representativeAssetId?: string;
  autoMatchKeys?: string[];
  compatibility: AssetFamilyCompatibility;
  createdAt: number;
  updatedAt: number;
}

export type GeneratedCreationInput =
  | {
      nodeId: string;
      inputId?: string;
      kind: "timelineSelection";
      /**
       * Absent on the abridged copy the asset index keeps: a selection embeds
       * whole clips and tracks, so the body lives in the metadata sidecar and
       * {@link GeneratedCreationInput.timelineSelectionStart} stands in for
       * synchronous callers that run before hydration.
       */
      timelineSelection?: TimelineSelection;
      /** Set only on the abridged index copy: the stripped selection's start tick. */
      timelineSelectionStart?: number;
      /**
       * The slot received a single frame captured from the selection, not the
       * rendered range. Kept beside the selection rather than read from its
       * `isPoint`, because the abridged index copy strips the selection body
       * and "Send to Timeline" must still prefer a range input over a frame.
       */
      isFrame?: true;
      miniEditorEdit?: GeneratedMiniEditorEdit;
      /** Per-item audio inclusion for a batch reference video. */
      includeEmbeddedAudio?: boolean;
      /** See the `draggedAsset` variant's `itemId`. */
      itemId?: string;
    }
  | {
      nodeId: string;
      inputId?: string;
      kind: "draggedAsset";
      parentAssetId: string;
      /** Per-item audio inclusion for a batch reference video. */
      includeEmbeddedAudio?: boolean;
      /**
       * The attachment's occurrence id. Written only into the project's saved
       * panel state, where reopening continues the same panel; generated-asset
       * metadata omits it, because a replay is a new panel and must not alias
       * the attachments of the run it copies.
       */
      itemId?: string;
    };

export interface GeneratedCreationWorkflowSelectionConfig {
  /**
   * Always a resolved number. A rule's `"project"` frame-rate link is pinned
   * to the rate in force when the snapshot was taken, so replaying a
   * generation reproduces its original conditions.
   */
  exportFps?: number;
  frameStep?: number;
  frameOffset?: number;
  maxFrames?: number;
  message?: string;
  includeTracks?: boolean;
}

export interface GeneratedCreationWorkflowInputDispatch {
  kind: "node";
  selectionConfig?: GeneratedCreationWorkflowSelectionConfig;
}

export interface GeneratedCreationWorkflowInputSnapshot {
  id?: string;
  nodeId: string;
  classType: string;
  inputType: "text" | "image" | "video" | "audio";
  param: string;
  label: string;
  description?: string | null;
  origin: "rule" | "inferred";
  repeatableMax?: number;
  dispatch?: GeneratedCreationWorkflowInputDispatch;
}

export interface GeneratedCreationReplayState {
  version: 1 | 2;
  workflowSourceId?: string | null;
  workflowInputs?: GeneratedCreationWorkflowInputSnapshot[];
  textValues?: Record<string, string>;
  widgetValues?: Record<string, string>;
  widgetModes?: Record<string, "fixed" | "randomize">;
  derivedWidgetValues?: Record<string, string>;
  /** Native panel node bypasses that must be restored when replaying. */
  bypassNodeIds?: string[];
  /** Nodes shipping bypassed that the panel turned on. */
  activateNodeIds?: string[];
  exactAspectRatio?: boolean;
  /**
   * The panel's aspect ratio choice: `"auto"` or a pinned `"<w>:<h>"` ratio.
   * Absent on assets generated before the selector existed, which replay as
   * `"auto"` to reproduce their probing behavior.
   */
  aspectRatioSelection?: string;
  pipelineInputs?: Record<string, Record<string, unknown>>;
  maskCropMode?: "crop" | "full";
  maskCropDilation?: number;
}

export type MaskCropMetadata =
  | { mode: "full" }
  | {
      mode: "cropped";
      crop_position: [number, number];
      /**
       * Present on newly generated assets. Legacy assets may only carry `scale`.
       */
      crop_size?: [number, number];
      /**
       * Present on newly generated assets. Legacy assets may require a project-size fallback.
       */
      container_size?: [number, number];
      scale: number;
    };

export interface GeneratedCreationMetadata {
  source: "generated";
  workflowName: string;
  inputs: GeneratedCreationInput[];
  targetResolution?: number;
  workflowSourceId?: string;
  replayState?: GeneratedCreationReplayState;
  maskCropMetadata?: MaskCropMetadata;
  generationMaskAssetId?: string;
  /**
   * Pixels of this asset the attached generation mask is grown by when
   * placed: how far the workflow repainted past the mask, from its
   * `generation_mask` rules. Absent means no grow. Set on import from
   * {@link sampledMaskGrow}.
   */
  generationMaskGrow?: number;
  /**
   * The same grow in the pixels the workflow sampled at. Resolved before
   * submission so the backend delivery manifest carries it; import derives
   * {@link generationMaskGrow} from it.
   */
  sampledMaskGrow?: number;
  /** The ComfyUI API prompt (node_id → {class_type, inputs}) that was executed. */
  comfyuiPrompt?: Record<string, unknown>;
  /** The authored ComfyUI visual workflow graph (LiteGraph format) used for editing/replay. */
  comfyuiWorkflow?: Record<string, unknown>;
  /** Set only on the abridged copy the asset index keeps: `comfyuiPrompt`/
   *  `comfyuiWorkflow` were moved into the metadata sidecar. Lets synchronous
   *  callers know a replay payload exists before the sidecar is hydrated. */
  replayPayloadInSidecar?: boolean;
  /** Generated inside the ComfyUI editor iframe (adopted delivery); regeneration
   *  reopens the editor instead of staying in the generation panel. */
  generatedInEditor?: boolean;
}

export interface ExtractedAudioClipMetadata {
  sourceAssetId: string;
  sourceClipType: "audio" | "video";
  timelineDuration: number;
  croppedSourceDuration: number;
  offset: number;
  transformedOffset: number;
  transformations: ClipTransform[];
}

/**
 * How a mask asset stores coverage. `binary`: coverage at or above half is
 * inside. `tsdf8_k8`: a truncated signed distance band, level
 * `127.5 - 8 * d` with d in pixels, negative inside
 * (docs/mask-distance-field-plan.md). Absent means `binary`.
 */
export type MaskAssetEncoding = "binary" | "tsdf8_k8";

export type CreationMetadata =
  | { source: "uploaded" }
  | GeneratedCreationMetadata
  | {
      source: "extracted";
      /** Absent on the abridged index copy; see {@link timelineSelectionStart}. */
      timelineSelection?: TimelineSelection;
      /** Set only on the abridged index copy: the stripped selection's start tick. */
      timelineSelectionStart?: number;
      extractedAudioClip?: ExtractedAudioClipMetadata;
    }
  | {
      /** A range or frame extracted directly from a library asset. */
      source: "asset_excerpt";
      parentAssetId: string;
      kind: "range" | "frame";
      startTicks: number;
      endTicks: number;
    }
  | {
      /** Baked video for a Composite clip; the selection is its content
       *  replayed at local zero. Distinct from "extracted" so the bake isn't
       *  treated as a user-extracted library clip. */
      source: "composite";
      compositeAssetId?: string;
      compositeClipId?: string;
      timelineSelection?: TimelineSelection;
      /** Set only on the abridged index copy: the stripped selection's start tick. */
      timelineSelectionStart?: number;
      contentHash?: string;
      /** Complete render-contract cache key for freshness validation. */
      bakeKey?: string;
      /** Canonical composite revision rendered into this asset. */
      compositeRevision?: number;
    }
  | {
      source: "sam2_mask";
      parentAssetId: string;
      parentClipId: string;
      maskClipId: string;
      pointCount: number;
      sourceHash: string;
      maskEncoding?: MaskAssetEncoding;
    }
  | {
      source: "sam_audio";
      stem: "target" | "residual";
      sourceAssetId: string;
      sourceClipId: string;
      jobId: string;
      startTicks: number;
      durationTicks: number;
    }
  | {
      source: "brush_mask";
      parentClipId: string;
      maskClipId: string;
    }
  | {
      source: "generation_mask";
      parentGeneratedAssetId: string;
    }
  | {
      source: "reversed";
      sourceAssetId: string;
    };

export interface Asset {
  id: string;
  hash: string; // xxhash
  familyId?: string;
  name: string;
  type: AssetType;
  favourite?: boolean;
  src: string; // Runtime: "blob:http://..." | Disk: "assets/my-video.mp4"
  /** Runtime-only persisted source path retained for lazy hydration/cleanup. */
  sourcePath?: string;
  thumbnail?: string; // Server URL for the thumbnail
  /** Runtime-only persisted thumbnail path retained for cleanup. */
  thumbnailPath?: string;
  proxySrc?: string; // Server URL for the proxy video
  /** Runtime-only persisted proxy path retained for cleanup. */
  proxyPath?: string;
  /** Persisted sidecar path for heavy asset metadata, relative to .vloproject. */
  metadataRef?: string;
  /** Runtime-only flag indicating whether metadataRef has been merged. */
  metadataLoaded?: boolean;
  proxyFile?: Blob; // Need Blob instead of File for when first ingested
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
  file?: File; // Optional local file reference (non-persisted)
  createdAt: number;
  creationMetadata?: CreationMetadata;
}
