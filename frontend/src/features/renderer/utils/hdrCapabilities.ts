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

export function detectHdrCapabilities(
  environmentDocument: Pick<Document, "createElement"> = document,
): HdrCapabilityMatrix {
  let displayP3Canvas = false;
  try {
    const canvas = environmentDocument.createElement("canvas");
    const context = canvas.getContext("2d", {
      colorSpace: "display-p3",
    } as CanvasRenderingContext2DSettings);
    displayP3Canvas =
      context?.getContextAttributes?.().colorSpace === "display-p3";
  } catch {
    // Older CanvasColorSpace WebIDL enums throw instead of returning null.
  }
  return buildHdrCapabilityMatrix({
    videoFrame: typeof VideoFrame !== "undefined",
    videoEncoder: typeof VideoEncoder !== "undefined",
    displayP3Canvas,
    hdrCanvas: false,
  });
}
