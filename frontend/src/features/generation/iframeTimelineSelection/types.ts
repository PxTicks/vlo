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
  thumbnail: File;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
  maskCropMetadata: MaskCropMetadata;
  warnings: ProcessingWarning[];
}

export interface StoredIframeTimelineSelection {
  selectionId: string;
  videoAsset: IframeTemporaryAsset;
  maskAsset: IframeTemporaryAsset | null;
}
