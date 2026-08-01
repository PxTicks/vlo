import { describe, expect, it } from "vitest";
import {
  capCompositePreviewRasterDimensions,
  MIN_COMPOSITE_RASTER_SHORT_EDGE,
  resolveCompositePreviewRasterDimensions,
  resolveCompositeRasterDimensions,
  resolveCompositeSourceRasterCeiling,
} from "../compositeRasterDimensions";

describe("resolveCompositePreviewRasterDimensions", () => {
  it("matches a smaller preview surface without imposing the bake floor", () => {
    expect(
      resolveCompositePreviewRasterDimensions(
        { width: 1920, height: 1080 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ width: 800, height: 450 });
  });

  it("uses physical preview pixels while preserving the logical aspect", () => {
    expect(
      resolveCompositePreviewRasterDimensions(
        { width: 1920, height: 1080 },
        { width: 1600, height: 1200 },
      ),
    ).toEqual({ width: 1600, height: 900 });
  });

  it("keeps ordinary preview rasters encoder-compatible for parity probes", () => {
    expect(
      resolveCompositePreviewRasterDimensions(
        { width: 1920, height: 1080 },
        { width: 1601, height: 1201 },
      ),
    ).toEqual({ width: 1600, height: 900 });
  });

  it("chooses a scalar-realizable even raster for a constrained viewport", () => {
    expect(
      resolveCompositePreviewRasterDimensions(
        { width: 1920, height: 1080 },
        { width: 584, height: 328 },
      ),
    ).toEqual({ width: 580, height: 326 });
  });

  it("allows high-DPI preview demand above logical project resolution", () => {
    expect(
      resolveCompositePreviewRasterDimensions(
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
      ),
    ).toEqual({ width: 3840, height: 2160 });
  });
});

describe("resolveCompositeSourceRasterCeiling", () => {
  it("uses a low-resolution source as a ceiling without inflating it", () => {
    expect(
      resolveCompositeSourceRasterCeiling(
        { width: 1920, height: 1080 },
        [{ width: 640, height: 360 }],
      ),
    ).toEqual({ width: 640, height: 360 });
  });

  it("uses the largest referenced source resolution", () => {
    expect(
      resolveCompositeSourceRasterCeiling(
        { width: 1920, height: 1080 },
        [
          { width: 640, height: 360 },
          { width: 3840, height: 2160 },
        ],
      ),
    ).toEqual({ width: 3840, height: 2160 });
  });

  it("does not impose a source ceiling on generated-only content", () => {
    expect(
      resolveCompositeSourceRasterCeiling(
        { width: 1920, height: 1080 },
        [],
      ),
    ).toBeNull();
  });
});

describe("capCompositePreviewRasterDimensions", () => {
  it("keeps a 720p floor when a low-resolution child may be mixed with generated content", () => {
    expect(
      capCompositePreviewRasterDimensions(
        { width: 3840, height: 2160 },
        { width: 640, height: 360 },
      ),
    ).toEqual({ width: 1280, height: MIN_COMPOSITE_RASTER_SHORT_EDGE });
  });

  it("caps preview demand at the largest child-source raster", () => {
    expect(
      capCompositePreviewRasterDimensions(
        { width: 3840, height: 2160 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps preview demand below the child-source ceiling", () => {
    expect(
      capCompositePreviewRasterDimensions(
        { width: 960, height: 540 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ width: 960, height: 540 });
  });
});

describe("resolveCompositeRasterDimensions", () => {
  it("uses a 720p floor for low-resolution or generated-only content", () => {
    expect(
      resolveCompositeRasterDimensions(
        { width: 1920, height: 1080 },
        [{ width: 640, height: 360 }],
      ),
    ).toEqual({ width: 1280, height: MIN_COMPOSITE_RASTER_SHORT_EDGE });
  });

  it("matches the largest source pixel resolution while preserving project aspect", () => {
    expect(
      resolveCompositeRasterDimensions(
        { width: 1920, height: 1080 },
        [
          { width: 640, height: 360 },
          { width: 3840, height: 2160 },
        ],
      ),
    ).toEqual({ width: 3840, height: 2160 });
  });

  it("matches source pixel resolution without inflating mismatched aspect ratios", () => {
    expect(
      resolveCompositeRasterDimensions(
        { width: 1920, height: 1080 },
        [{ width: 1080, height: 1920 }],
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });
});
