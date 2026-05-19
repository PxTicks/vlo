import type { ClipTransform, TimelineSelection } from "./TimelineTypes";

export type AssetType = "video" | "image" | "audio";

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
      kind: "timelineSelection";
      timelineSelection: TimelineSelection;
    }
  | {
      nodeId: string;
      kind: "draggedAsset";
      parentAssetId: string;
    };

export interface GeneratedCreationWorkflowSelectionConfig {
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
      source: "sam2_mask";
      parentAssetId: string;
      parentClipId: string;
      maskClipId: string;
      pointCount: number;
      sourceHash: string;
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
