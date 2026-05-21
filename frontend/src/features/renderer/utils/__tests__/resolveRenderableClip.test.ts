import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeTimelineClip,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import { hashCompositeContent } from "../../../timelineSelection";
import { resolveRenderableClip } from "../resolveRenderableClip";

function videoClip(id: string): VideoTimelineClip {
  return {
    id,
    type: "video",
    name: id,
    assetId: `asset-${id}`,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
    trackId: "track-1",
    start: 0,
  };
}

function proxyAsset(id: string): Asset {
  return {
    id,
    name: `${id}.mp4`,
    src: `${id}.mp4`,
    type: "video",
    hash: `hash-${id}`,
    createdAt: 1,
  };
}

function compositeClip(proxyContentHash: string): CompositeTimelineClip {
  const content = {
    durationTicks: 100,
    clips: [videoClip("nested")],
  };

  return {
    id: "composite-1",
    type: "composite",
    name: "Composite",
    trackId: "track-1",
    start: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
    content,
    proxyAssetId: "proxy-1",
    proxyContentHash,
  };
}

describe("resolveRenderableClip", () => {
  it("flattens a fresh composite to a proxy-backed video clip", () => {
    const content = {
      durationTicks: 100,
      clips: [videoClip("nested")],
    };
    const clip = {
      ...compositeClip(hashCompositeContent(content)),
      content,
    };

    expect(
      resolveRenderableClip(clip, new Map([["proxy-1", proxyAsset("proxy-1")]])),
    ).toEqual(
      expect.objectContaining({
        id: "composite-1",
        type: "video",
        assetId: "proxy-1",
      }),
    );
  });

  it("drops stale composites instead of rendering an old proxy", () => {
    expect(
      resolveRenderableClip(
        compositeClip("stale"),
        new Map([["proxy-1", proxyAsset("proxy-1")]]),
      ),
    ).toBeNull();
  });
});
