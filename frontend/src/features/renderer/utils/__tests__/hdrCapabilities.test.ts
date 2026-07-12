import { describe, expect, it } from "vitest";
import {
  buildHdrCapabilityMatrix,
  detectHdrCapabilities,
} from "../hdrCapabilities";

describe("HDR capability matrix", () => {
  it("keeps browser paths gated while pure color math remains available", () => {
    expect(
      buildHdrCapabilityMatrix({
        videoFrame: true,
        videoEncoder: true,
        displayP3Canvas: false,
        hdrCanvas: false,
      }),
    ).toEqual({
      colorMath: "available",
      metadataPreservingIngest: "experimental",
      wideGamutCanvas: "unavailable",
      hdrCanvas: "unavailable",
      tenBitExport: "experimental",
    });
  });

  it("classifies display P3 as unavailable when the canvas enum throws", () => {
    const environmentDocument = {
      createElement: () => ({
        getContext: () => {
          throw new TypeError("Unsupported CanvasColorSpace");
        },
      }),
    } as unknown as Pick<Document, "createElement">;

    expect(detectHdrCapabilities(environmentDocument).wideGamutCanvas).toBe(
      "unavailable",
    );
  });
});
