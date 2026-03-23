import type { TimelineSelection } from "./TimelineTypes";

export type AssetType = "video" | "image" | "audio";

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
  maskCropMetadata?: MaskCropMetadata;
  generationMaskAssetId?: string;
  /** The ComfyUI API prompt (node_id → {class_type, inputs}) that was executed. */
  comfyuiPrompt?: Record<string, unknown>;
  /** The ComfyUI visual workflow graph (LiteGraph format) with resolved values. */
  comfyuiWorkflow?: Record<string, unknown>;
}

export type CreationMetadata =
  | { source: "uploaded" }
  | GeneratedCreationMetadata
  | { source: "extracted"; timelineSelection: TimelineSelection }
  | {
      source: "sam2_mask";
      parentAssetId: string;
      parentClipId: string;
      maskClipId: string;
      pointCount: number;
      sourceHash: string;
    }
  | {
      source: "generation_mask";
      parentGeneratedAssetId: string;
    };

export interface Asset {
  id: string;
  hash: string; // xxhash
  name: string;
  type: AssetType;
  favourite?: boolean;
  src: string; // Runtime: "blob:http://..." | Disk: "assets/my-video.mp4"
  thumbnail?: string; // Server URL for the thumbnail
  proxySrc?: string; // Server URL for the proxy video
  proxyFile?: Blob; // Need Blob instead of File for when first ingested
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
  file?: File; // Optional local file reference (non-persisted)
  createdAt: number;
  creationMetadata?: CreationMetadata;
}
