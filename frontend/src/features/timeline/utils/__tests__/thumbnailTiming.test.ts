import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../constants";
import {
  clampThumbnailAssetTickToFirstFrame,
  getFirstPresentedFrameTicks,
  resolveThumbnailBucketRequestSeconds,
} from "../thumbnailTiming";

describe("thumbnailTiming", () => {
  it("returns zero when a track starts at or before zero", () => {
    expect(getFirstPresentedFrameTicks()).toBe(0);
    expect(getFirstPresentedFrameTicks(0)).toBe(0);
    expect(getFirstPresentedFrameTicks(-0.1)).toBe(0);
  });

  it("clamps early thumbnail ticks to the first presented frame", () => {
    const firstTimestampSeconds = 0.0585;
    const firstPresentedFrameTicks = Math.round(
      firstTimestampSeconds * TICKS_PER_SECOND,
    );

    expect(
      clampThumbnailAssetTickToFirstFrame(0, firstTimestampSeconds),
    ).toBe(firstPresentedFrameTicks);
    expect(
      clampThumbnailAssetTickToFirstFrame(4000, firstTimestampSeconds),
    ).toBe(firstPresentedFrameTicks);
    expect(
      clampThumbnailAssetTickToFirstFrame(9000, firstTimestampSeconds),
    ).toBe(9000);
  });

  it("uses the first presented frame when a bucket starts before it", () => {
    const firstTimestampSeconds = 0.0585;
    const requestSeconds = resolveThumbnailBucketRequestSeconds(
      0,
      4000,
      firstTimestampSeconds,
    );

    expect(requestSeconds).toBeCloseTo(firstTimestampSeconds, 6);
    expect(
      resolveThumbnailBucketRequestSeconds(2, 4000, firstTimestampSeconds),
    ).toBeCloseTo(8000 / TICKS_PER_SECOND, 6);
  });
});
