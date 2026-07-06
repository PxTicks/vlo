import type { Asset, MaskCropMetadata } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type { AspectRatioProcessingMetadata } from "../types";
import type { ProcessingWarning } from "../processing";

export interface IframeTimelineSelectionSettings {
  aspectRatio: {
    enabled: boolean;
    targetAspectRatio: string;
    targetResolution: number;
    stride: number;
    searchSteps: number;
  };
  maskCrop: {
    mode: "full" | "crop";
    dilation: number;
  };
}

export type IframeTemporaryAssetRole = "video" | "mask";

export interface IframeTemporaryAsset {
  asset: Asset;
  role: IframeTemporaryAssetRole;
  selectionId: string;
  timelineSelection: TimelineSelection;
  maskCropMetadata: MaskCropMetadata;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
}

export interface ProcessedIframeTimelineSelection {
  timelineSelection: TimelineSelection;
  video: File;
  mask: File | null;
  /** Thumbnail captured from the timeline frame (the video's poster). */
  thumbnail: File;
  /**
   * Thumbnail captured from the rendered mask matte itself, so the mask card
   * shows the black/white matte rather than reusing the video's frame. Null
   * whenever there is no mask.
   */
  maskThumbnail: File | null;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
  maskCropMetadata: MaskCropMetadata;
  warnings: ProcessingWarning[];
}

export interface StoredIframeTimelineSelection {
  selectionId: string;
  videoAsset: IframeTemporaryAsset;
  maskAsset: IframeTemporaryAsset | null;
}
