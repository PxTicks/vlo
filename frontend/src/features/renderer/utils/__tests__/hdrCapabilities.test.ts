import { describe, expect, it } from "vitest";
import { buildHdrCapabilityMatrix } from "../hdrCapabilities";

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
});
