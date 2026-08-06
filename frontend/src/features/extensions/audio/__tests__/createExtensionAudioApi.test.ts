import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Input, InputAudioTrack, WrappedAudioBuffer } from "mediabunny";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import {
  AudioAnalysisService,
  useAssetStore,
} from "../../../userAssets";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip, TimelineTrack } from "../../../../types/TimelineTypes";
import { createExtensionAudioApi } from "../createExtensionAudioApi";

function createScope(
  signal: AbortSignal = new AbortController().signal,
): ExtensionApiScope {
  return {
    extension: { id: "example.beats", version: "1.0.0" },
    signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: "asset-audio",
    hash: "hash",
    name: "Audio",
    type: "audio",
    src: "audio.wav",
    duration: 2,
    hasAudio: true,
    createdAt: 1,
    ...overrides,
  };
}

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    id: "clip-audio",
    type: "audio",
    name: "Audio",
    assetId: "asset-audio",
    trackId: "track-audio",
    sourceDuration: 192_000,
    transformedDuration: 192_000,
    transformedOffset: 0,
    timelineDuration: 96_000,
    croppedSourceDuration: 192_000,
    offset: 24_000,
    start: 48_000,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

const tracks: TimelineTrack[] = [
  {
    id: "track-audio",
    label: "Audio",
    type: "audio",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  },
  {
    id: "track-visual",
    label: "Visual",
    type: "visual",
    isVisible: true,
    isMuted: true,
    isLocked: false,
  },
];

function createDecoder(
  values: readonly number[],
  sampleRate = 4,
  firstTimestampSeconds = 0,
) {
  const track = {
    sampleRate,
    numberOfChannels: 1,
    canDecode: vi.fn(async () => true),
    computeDuration: vi.fn(
      async () => firstTimestampSeconds + values.length / sampleRate,
    ),
    getFirstTimestamp: vi.fn(async () => firstTimestampSeconds),
  } as unknown as InputAudioTrack;
  const input = {
    getPrimaryAudioTrack: vi.fn(async () => track),
  } as unknown as Input;
  const buffer = {
    sampleRate,
    numberOfChannels: 1,
    length: values.length,
    getChannelData: () => Float32Array.from(values),
  } as unknown as AudioBuffer;
  const wrapped: WrappedAudioBuffer = {
    buffer,
    timestamp: firstTimestampSeconds,
    duration: values.length / sampleRate,
  };
  const createSink = () => ({
    buffers: async function* () {
      yield wrapped;
    },
  });
  return {
    input,
    analysis: new AudioAnalysisService({
      getInput: async () => input,
      createSink,
    }),
  };
}

beforeEach(() => {
  useAssetStore.setState({
    assets: [
      asset({}),
      asset({
        id: "asset-video-audio",
        name: "Video with audio",
        type: "video",
      }),
      asset({
        id: "asset-video-silent",
        name: "Silent video",
        type: "video",
        hasAudio: false,
      }),
    ],
  });
  useTimelineStore.setState({
    tracks,
    clips: [
      clip({}),
      clip({
        id: "clip-video-audio",
        type: "video",
        assetId: "asset-video-audio",
        trackId: "track-visual",
      }),
      clip({
        id: "clip-video-silent",
        type: "video",
        assetId: "asset-video-silent",
        trackId: "track-visual",
      }),
    ],
  });
});

describe("createExtensionAudioApi", () => {
  it("projects audio-bearing clips and tracks without exposing silent video", () => {
    const api = createExtensionAudioApi(createScope());

    expect(api.listClips()).toEqual([
      expect.objectContaining({
        id: "clip-audio",
        sourceOffsetTicks: 24_000,
        croppedSourceDurationTicks: 192_000,
      }),
      expect.objectContaining({ id: "clip-video-audio", type: "video" }),
    ]);
    expect(api.getClip("clip-video-silent")).toBeUndefined();
    expect(api.listTracks()).toEqual([
      expect.objectContaining({
        id: "track-audio",
        clipIds: ["clip-audio"],
      }),
      expect.objectContaining({
        id: "track-visual",
        isMuted: true,
        clipIds: ["clip-video-audio"],
      }),
    ]);
  });

  it("decodes an exact bounded PCM range and derives a peak envelope", async () => {
    const decoder = createDecoder([-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5]);
    const api = createExtensionAudioApi(createScope(), {
      analysis: decoder.analysis,
    });

    const pcm = await api.readPcm("asset-audio", {
      startSeconds: 0.5,
      endSeconds: 1.5,
    });
    expect(pcm.ok).toBe(true);
    if (!pcm.ok) return;
    expect(pcm.source).toMatchObject({ sampleRate: 4, numberOfChannels: 1 });
    expect(Array.from(pcm.channels[0]!)).toEqual([0, 0.5, 1, 0.5]);

    const waveform = await api.readWaveform("asset-audio", {
      startSeconds: 0.5,
      endSeconds: 1.5,
      samplesPerPeak: 2,
    });
    expect(waveform.ok).toBe(true);
    if (!waveform.ok) return;
    expect(Array.from(waveform.channels[0]!.min)).toEqual([0, 0.5]);
    expect(Array.from(waveform.channels[0]!.max)).toEqual([0.5, 1]);
  });

  it.each([2, -2])(
    "treats decoder duration as an end timestamp when the stream starts at %s",
    async (firstTimestampSeconds) => {
      const decoder = createDecoder(
        [-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5],
        4,
        firstTimestampSeconds,
      );
      const api = createExtensionAudioApi(createScope(), {
        analysis: decoder.analysis,
      });

      const inspected = await api.inspect("asset-audio");
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.source).toMatchObject({
        firstTimestampSeconds,
        endTimestampSeconds: firstTimestampSeconds + 2,
        durationSeconds: 2,
        maxPcmFramesPerRead: 4_000_000,
      });

      const pcm = await api.readPcm("asset-audio");
      expect(pcm.ok).toBe(true);
      if (!pcm.ok) return;
      expect(pcm.startSeconds).toBe(firstTimestampSeconds);
      expect(pcm.durationSeconds).toBe(2);
      expect(Array.from(pcm.channels[0]!)).toEqual([
        -1,
        -0.5,
        0,
        0.5,
        1,
        0.5,
        0,
        -0.5,
      ]);
    },
  );

  it("returns typed source/range failures and throws for malformed requests", async () => {
    const decoder = createDecoder([0, 0, 0, 0]);
    const api = createExtensionAudioApi(createScope(), {
      analysis: decoder.analysis,
    });

    await expect(api.inspect("missing")).resolves.toMatchObject({
      ok: false,
      code: "asset_not_found",
    });
    await expect(
      api.readPcm("asset-audio", { startSeconds: 5, endSeconds: 6 }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_range" });
    await expect(
      api.readWaveform("asset-audio", { samplesPerPeak: 0 }),
    ).rejects.toThrow("positive integer");
    await expect(
      api.readPcm("asset-audio", { startSeconds: Number.NaN }),
    ).rejects.toThrow("finite");
    await expect(
      api.readPcm("missing", { startSeconds: Number.NaN }),
    ).rejects.toThrow("finite");
    await expect(
      api.readWaveform("missing", { samplesPerPeak: 0 }),
    ).rejects.toThrow("positive integer");
    await expect(api.inspect(" ")).rejects.toThrow("non-empty asset ID");
  });

  it("rejects with AbortError when extension deactivation cancels the scope", async () => {
    const controller = new AbortController();
    const decoder = createDecoder([0, 0, 0, 0]);
    const api = createExtensionAudioApi(createScope(controller.signal), {
      analysis: decoder.analysis,
    });

    controller.abort();

    await expect(api.inspect("asset-audio")).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(api.inspect("missing")).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
