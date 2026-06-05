import { describe, expect, it } from "vitest";
import { createCompositeTimelineClip } from "../createCompositeClip";

describe("createCompositeTimelineClip", () => {
  it("builds an asset-backed video clip tagged with the composite id", () => {
    const clip = createCompositeTimelineClip({
      compositeId: "composite-1",
      assetId: "bake-1",
      durationTicks: 120,
      trackId: "track-1",
      start: 0,
    });

    expect(clip).toMatchObject({
      type: "video",
      assetId: "bake-1",
      compositeId: "composite-1",
      trackId: "track-1",
      start: 0,
      sourceDuration: 120,
      timelineDuration: 120,
      croppedSourceDuration: 120,
      transformedDuration: 120,
    });
  });
});
