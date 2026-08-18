import type { ClipTransform, TimelineSelection } from "./TimelineTypes";

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
      timelineSelection: TimelineSelection;
    }
  | {
      nodeId: string;
      inputId?: string;
      kind: "draggedAsset";
      parentAssetId: string;
    };

export interface GeneratedCreationWorkflowSelectionConfig {
  /**
   * Always a resolved number. A rule's `"project"` frame-rate link is pinned
   * to the rate in force when the snapshot was taken, so replaying a
   * generation reproduces its original conditions.
   */
  exportFps?: number;
  frameStep?: number;
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
  exactAspectRatio?: boolean;
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

export type CreationMetadata =
  | { source: "uploaded" }
  | GeneratedCreationMetadata
  | {
      source: "extracted";
      timelineSelection: TimelineSelection;
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
