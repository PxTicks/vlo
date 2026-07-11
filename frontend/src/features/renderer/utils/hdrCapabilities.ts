export type HdrCapabilityStatus = "available" | "experimental" | "unavailable";

export interface HdrCapabilityMatrix {
  readonly colorMath: HdrCapabilityStatus;
  readonly metadataPreservingIngest: HdrCapabilityStatus;
  readonly wideGamutCanvas: HdrCapabilityStatus;
  readonly hdrCanvas: HdrCapabilityStatus;
  readonly tenBitExport: HdrCapabilityStatus;
}

interface HdrEnvironment {
  readonly videoFrame: boolean;
  readonly videoEncoder: boolean;
  readonly displayP3Canvas: boolean;
  readonly hdrCanvas: boolean;
}

export function buildHdrCapabilityMatrix(
  environment: HdrEnvironment,
): HdrCapabilityMatrix {
  return {
    colorMath: "available",
    // The current decoder intentionally transfers frames through ImageBitmap.
    metadataPreservingIngest: environment.videoFrame
      ? "experimental"
      : "unavailable",
    wideGamutCanvas: environment.displayP3Canvas
      ? "experimental"
      : "unavailable",
    hdrCanvas: environment.hdrCanvas ? "experimental" : "unavailable",
    tenBitExport: environment.videoEncoder ? "experimental" : "unavailable",
  };
}

export function detectHdrCapabilities(): HdrCapabilityMatrix {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", {
    colorSpace: "display-p3",
  } as CanvasRenderingContext2DSettings);
  const attributes = context?.getContextAttributes?.();
  return buildHdrCapabilityMatrix({
    videoFrame: typeof VideoFrame !== "undefined",
    videoEncoder: typeof VideoEncoder !== "undefined",
    displayP3Canvas: attributes?.colorSpace === "display-p3",
    hdrCanvas: false,
  });
}
