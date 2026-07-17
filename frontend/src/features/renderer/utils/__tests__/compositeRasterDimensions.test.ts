import { describe, expect, it } from "vitest";
import {
  MIN_COMPOSITE_RASTER_SHORT_EDGE,
  resolveCompositeRasterDimensions,
} from "../compositeRasterDimensions";

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
