import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  AudioTimelineClip,
  CompositeTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { hashCompositeContent } from "../../../timelineSelection";
import {
  resolveRenderableAudioClipLanes,
  resolveRenderableClip,
} from "../resolveRenderableClip";
import { calculatePlayerFrameTime } from "../mediaTime";

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

function proxyAsset(id: string, duration?: number): Asset {
  return {
    id,
    name: `${id}.mp4`,
    src: `${id}.mp4`,
    type: "video",
    hash: `hash-${id}`,
    ...(duration !== undefined ? { duration } : {}),
    createdAt: 1,
  };
}

function audioAsset(id: string): Asset {
  return {
    id,
    name: `${id}.wav`,
    src: `${id}.wav`,
    type: "audio",
    hash: `hash-${id}`,
    duration: 1,
    createdAt: 1,
  };
}

function audioClip(id: string, assetId: string, trackId: string): AudioTimelineClip {
  return {
    id,
    type: "audio",
    name: id,
    assetId,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
    trackId,
    start: 0,
  };
}

function audioTrack(id: string): TimelineTrack {
  return {
    id,
    type: "audio",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
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

  it("uses the baked proxy duration for full-length composites", () => {
    const content = {
      durationTicks: 100,
      clips: [videoClip("nested")],
    };
    const clip = {
      ...compositeClip(hashCompositeContent(content)),
      content,
    };

    const resolved = resolveRenderableClip(
      clip,
      new Map([
        ["proxy-1", proxyAsset("proxy-1", 120 / TICKS_PER_SECOND)],
      ]),
    );

    expect(resolved).toEqual(
      expect.objectContaining({
        type: "video",
        sourceDuration: 120,
        timelineDuration: 120,
        croppedSourceDuration: 120,
        transformedDuration: 120,
      }),
    );
  });

  it("expands audio-only composites into separate audio lanes", () => {
    const clip: CompositeTimelineClip = {
      id: "split-1",
      type: "composite",
      contentKind: "audio",
      name: "Split",
      trackId: "track-1",
      start: 50,
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      content: {
        durationTicks: 100,
        tracks: [audioTrack("target-track"), audioTrack("residual-track")],
        clips: [
          audioClip("target", "target-asset", "target-track"),
          audioClip("residual", "residual-asset", "residual-track"),
        ],
      },
    };

    const lanes = resolveRenderableAudioClipLanes(
      [clip],
      new Map([
        ["target-asset", audioAsset("target-asset")],
        ["residual-asset", audioAsset("residual-asset")],
      ]),
    );

    expect(lanes).toHaveLength(2);
    expect(lanes.map((lane) => lane[0]?.id)).toEqual([
      "split-1::target",
      "split-1::residual",
    ]);
    expect(lanes[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "audio",
        start: 50,
        timelineDuration: 100,
        trackId: "track-1",
      }),
    );
  });

  it("keeps audio-only composite stems aligned under speed transforms", () => {
    const sourceDuration = 2 * TICKS_PER_SECOND;
    const timelineDuration = TICKS_PER_SECOND;
    const start = 10 * TICKS_PER_SECOND;
    const clip: CompositeTimelineClip = {
      id: "split-speed",
      type: "composite",
      contentKind: "audio",
      name: "Split speed",
      trackId: "track-1",
      start,
      sourceDuration,
      transformedDuration: timelineDuration,
      transformedOffset: 0,
      timelineDuration,
      croppedSourceDuration: sourceDuration,
      offset: 0,
      transformations: [
        {
          id: "speed-2x",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
      content: {
        durationTicks: sourceDuration,
        tracks: [audioTrack("target-track")],
        clips: [
          {
            ...audioClip("target", "target-asset", "target-track"),
            sourceDuration,
            transformedDuration: sourceDuration,
            timelineDuration: sourceDuration,
            croppedSourceDuration: sourceDuration,
          },
        ],
      },
    };

    const lanes = resolveRenderableAudioClipLanes(
      [clip],
      new Map([["target-asset", audioAsset("target-asset")]]),
    );
    const stemClip = lanes[0]?.[0];

    expect(stemClip).toEqual(
      expect.objectContaining({
        start,
        sourceDuration,
        timelineDuration,
        croppedSourceDuration: sourceDuration,
        transformedDuration: timelineDuration,
      }),
    );
    expect(calculatePlayerFrameTime(stemClip!, start)).toBeCloseTo(0);
    expect(
      calculatePlayerFrameTime(stemClip!, start + timelineDuration / 2),
    ).toBeCloseTo(1);
    expect(
      calculatePlayerFrameTime(stemClip!, start + timelineDuration),
    ).toBeCloseTo(2);
  });
});
