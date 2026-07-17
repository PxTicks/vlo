import { describe, expect, it } from "vitest";
import {
  createCompositeTimelineClip,
  createCompositeTimelineClipFromAsset,
} from "../createCompositeClip";

describe("createCompositeTimelineClip", () => {
  it("builds an asset-backed video clip tagged with the composite id", () => {
    const clip = createCompositeTimelineClip({
      compositeId: "composite-1",
      compositeRevision: 4,
      assetId: "bake-1",
      durationTicks: 120,
      trackId: "track-1",
      start: 0,
    });

    expect(clip).toMatchObject({
      type: "video",
      assetId: "bake-1",
      compositeId: "composite-1",
      compositeRevision: 4,
      trackId: "track-1",
      start: 0,
      sourceDuration: 120,
      timelineDuration: 120,
      croppedSourceDuration: 120,
      transformedDuration: 120,
    });
  });

  it("places a ready legacy composite through its ordinary baked asset", () => {
    const clip = createCompositeTimelineClipFromAsset(
      {
        id: "legacy-composite",
        name: "Legacy",
        content: { clips: [], durationTicks: 90 },
        bakedAssetId: "legacy-bake",
        createdAt: 1,
        updatedAt: 1,
      },
      { trackId: "track-1", start: 10 },
    );

    expect(clip).toMatchObject({
      compositeId: "legacy-composite",
      compositeRevision: 1,
      assetId: "legacy-bake",
      timelineDuration: 90,
    });
  });
});
