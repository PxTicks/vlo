import { afterEach, describe, expect, it, vi } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../../../composite";
import { createCompositeSourcePolicySnapshot } from "../framePlanning/CompositeSourcePolicy";
import { CompositeAudioTrackRenderer } from "../CompositeAudioTrackRenderer";

function track(id: string, type: TimelineTrack["type"]): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function clip(
  id: string,
  trackId: string,
  assetId: string,
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId,
    start: 0,
    sourceDuration: TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    timelineDuration: TICKS_PER_SECOND,
    croppedSourceDuration: TICKS_PER_SECOND,
    offset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function asset(id: string): Asset {
  return {
    id,
    hash: `${id}-hash`,
    name: id,
    type: "video",
    duration: 1,
    hasAudio: true,
    src: `blob:${id}`,
    creationMetadata: { source: "uploaded" },
  } as Asset;
}

function createContext() {
  const createParam = () => ({
    value: 1,
    setValueAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
  });
  const createNode = (extra: Record<string, unknown> = {}) => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    ...extra,
  });
  return {
    currentTime: 0,
    createGain: vi.fn(() => createNode({ gain: createParam() })),
    createStereoPanner: vi.fn(() => createNode({ pan: createParam() })),
  } as unknown as BaseAudioContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CompositeAudioTrackRenderer", () => {
  it("pins source mode until reset and builds one parent effect chain for all lanes", async () => {
    vi.stubGlobal("OfflineAudioContext", class OfflineAudioContextMock {});
    const parentTrack = track("parent", "visual");
    const childTracks = [
      track("child-video", "visual"),
      track("child-audio", "audio"),
    ];
    const childAsset = asset("child-asset");
    const bakeAsset = asset("bake-asset");
    const childClips = [
      clip("child-video", childTracks[0].id, childAsset.id),
      clip("child-audio", childTracks[1].id, childAsset.id, {
        type: "audio",
      }),
    ];
    const composite: CompositeAsset = {
      id: "composite",
      name: "Composite",
      revision: 1,
      content: {
        tracks: childTracks,
        clips: childClips,
        durationTicks: TICKS_PER_SECOND,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const dimensions = { width: 1280, height: 720 };
    const assets = [childAsset, bakeAsset];
    const readyKey = serializeCompositeBakeKey(
      createCompositeBakeKey({
        content: composite.content,
        projectFps: 30,
        logicalDimensions: dimensions,
        assets,
      }),
    );
    composite.bake = {
      status: "ready",
      requestedKey: readyKey,
      readyKey,
      readyRevision: 1,
      assetId: bakeAsset.id,
    };
    const placement = clip("placement", parentTrack.id, bakeAsset.id, {
      compositeId: composite.id,
      compositeRevision: 1,
      transformations: [
        {
          id: "parent-pan",
          type: "pan",
          isEnabled: true,
          parameters: { pan: 0.25 },
        },
      ],
    });
    const automaticSource = {
      tracks: [parentTrack],
      clips: [placement],
      composites: [composite],
      assets,
      projectFps: 30,
      logicalDimensions: dimensions,
    };
    const renderer = new CompositeAudioTrackRenderer(
      parentTrack.id,
      null,
      automaticSource,
    );
    const ctx = createContext();
    const destination = { id: "master" } as unknown as AudioNode;
    const getInput = vi.fn(async () => null);
    const process = () =>
      renderer.process(
        ctx,
        destination,
        [placement],
        getInput,
        { baseTicks: 0, baseContextTime: 0 },
        { lookahead: 0.05, forceFlush: true },
      );

    await process();
    expect(
      (ctx.createStereoPanner as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);

    renderer.setCompositeSourceData({
      ...automaticSource,
      sourcePolicy: createCompositeSourcePolicySnapshot({
        forceLiveCompositeIds: new Set([composite.id]),
      }),
    });
    await process();
    expect(
      (ctx.createStereoPanner as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);

    renderer.reset(0);
    await process();
    expect(
      (ctx.createStereoPanner as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);

    renderer.dispose();
  });
});
