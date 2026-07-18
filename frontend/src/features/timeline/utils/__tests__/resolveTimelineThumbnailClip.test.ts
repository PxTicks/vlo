import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeAsset,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../../../composite";
import { resolveTimelineThumbnailClip } from "../resolveTimelineThumbnailClip";

const logicalDimensions = { width: 1920, height: 1080 };
const projectFps = 30;
const content = { durationTicks: 96000, clips: [], fps: 30 };
const bakeAsset: Asset = {
  id: "bake-current",
  hash: "bake-hash",
  name: "bake.webm",
  type: "video",
  src: "blob:bake",
  createdAt: 1,
};
const placement: VideoTimelineClip = {
  id: "placement",
  trackId: "track",
  type: "video",
  name: "Composite",
  assetId: "composite-live:composite",
  compositeId: "composite",
  compositeRevision: 1,
  start: 0,
  timelineDuration: 96000,
  offset: 0,
  croppedSourceDuration: 96000,
  transformedOffset: 0,
  sourceDuration: 96000,
  transformedDuration: 96000,
  transformations: [],
};

function readyComposite(readyKey: string): CompositeAsset {
  return {
    id: "composite",
    name: "Composite",
    content,
    revision: 1,
    bake: {
      status: "ready",
      requestedKey: readyKey,
      readyKey,
      readyRevision: 1,
      assetId: bakeAsset.id,
    },
    bakedAssetId: bakeAsset.id,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("resolveTimelineThumbnailClip", () => {
  it("uses the valid current bake after history restores a live placement pointer", () => {
    const bakeKey = serializeCompositeBakeKey(
      createCompositeBakeKey({
        content,
        projectFps,
        logicalDimensions,
        assets: [bakeAsset],
      }),
    );

    expect(
      resolveTimelineThumbnailClip({
        clip: placement,
        composite: readyComposite(bakeKey),
        assets: [bakeAsset],
        logicalDimensions,
        projectFps,
      }),
    ).toMatchObject({ assetId: bakeAsset.id });
  });

  it("does not expose a stale bake to the ordinary thumbnail decoder", () => {
    expect(
      resolveTimelineThumbnailClip({
        clip: placement,
        composite: readyComposite("stale-key"),
        assets: [bakeAsset],
        logicalDimensions,
        projectFps,
      }),
    ).toBe(placement);
  });
});
