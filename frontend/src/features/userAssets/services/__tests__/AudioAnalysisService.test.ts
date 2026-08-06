import { describe, expect, it, vi } from "vitest";
import type { Input, InputAudioTrack, WrappedAudioBuffer } from "mediabunny";
import { AudioAnalysisService } from "../AudioAnalysisService";

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
  const wrapped: WrappedAudioBuffer = {
    timestamp: firstTimestampSeconds,
    duration: values.length / sampleRate,
    buffer: {
      sampleRate,
      numberOfChannels: 1,
      length: values.length,
      getChannelData: () => Float32Array.from(values),
    } as unknown as AudioBuffer,
  };
  const service = new AudioAnalysisService({
    getInput: async () => input,
    createSink: () => ({
      buffers: async function* () {
        yield wrapped;
      },
    }),
  });
  return { input, service, track };
}

describe("AudioAnalysisService", () => {
  it("publishes timestamp bounds separately from the true stream span", async () => {
    const { service } = createDecoder([0, 0, 0, 0, 0, 0, 0, 0], 4, -1);

    await expect(service.inspect("asset-audio")).resolves.toEqual({
      assetId: "asset-audio",
      sampleRate: 4,
      numberOfChannels: 1,
      durationSeconds: 2,
      firstTimestampSeconds: -1,
      endTimestampSeconds: 1,
    });
  });

  it("decodes bounded PCM and waveform data through one source path", async () => {
    const { input, service, track } = createDecoder(
      [-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5],
      4,
      -1,
    );

    const pcm = await service.readPcm("asset-audio", {
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(pcm.startSeconds).toBe(0);
    expect(Array.from(pcm.channels[0]!)).toEqual([1, 0.5, 0, -0.5]);

    const waveform = await service.readWaveform("asset-audio", {
      startSeconds: 0,
      endSeconds: 1,
      samplesPerPeak: 2,
      peakOriginSeconds: 0,
    });
    expect(waveform.firstPeakIndex).toBe(0);
    expect(Array.from(waveform.channels[0]!.min)).toEqual([0.5, -0.5]);
    expect(Array.from(waveform.channels[0]!.max)).toEqual([1, 0]);
    expect(input.getPrimaryAudioTrack).toHaveBeenCalledOnce();
    expect(track.canDecode).toHaveBeenCalledOnce();
    expect(track.computeDuration).toHaveBeenCalledOnce();
    expect(track.getFirstTimestamp).toHaveBeenCalledOnce();
  });

  it("keeps host waveform peaks aligned to an explicit source origin", async () => {
    const { service } = createDecoder([0.75, -0.5, 0.25, 1], 4, 0.25);

    const waveform = await service.readWaveform("asset-audio", {
      startSeconds: 0,
      endSeconds: 1.25,
      samplesPerPeak: 2,
      peakOriginSeconds: 0,
    });

    expect(waveform.firstPeakIndex).toBe(0);
    expect(Array.from(waveform.channels[0]!.min)).toEqual([
      0.75,
      -0.5,
      1,
    ]);
    expect(Array.from(waveform.channels[0]!.max)).toEqual([
      0.75,
      0.25,
      1,
    ]);
  });

  it("reports policy limits and invalid ranges without flattening them", async () => {
    const { service } = createDecoder([0, 0, 0, 0]);

    await expect(
      service.readPcm("asset-audio", { maxFrames: 3 }),
    ).rejects.toMatchObject({ code: "range_too_large" });
    await expect(
      service.readPcm("asset-audio", { startSeconds: 4, endSeconds: 5 }),
    ).rejects.toMatchObject({ code: "invalid_range" });
    await expect(
      service.readWaveform("asset-audio", { samplesPerPeak: 0 }),
    ).rejects.toThrow("positive integer");
    await expect(
      service.readPcm("asset-audio", { startSeconds: Number.NaN }),
    ).rejects.toThrow("finite");
  });

  it("distinguishes missing audio and cancellation", async () => {
    const noAudio = new AudioAnalysisService({
      getInput: async () =>
        ({
          getPrimaryAudioTrack: vi.fn(async () => null),
        }) as unknown as Input,
    });
    await expect(noAudio.inspect("asset-audio")).rejects.toMatchObject({
      code: "no_audio",
    });

    const controller = new AbortController();
    const getInput = vi.fn(async () => null);
    const cancelled = new AudioAnalysisService({ getInput });
    controller.abort();
    await expect(
      cancelled.inspect("asset-audio", { signals: [controller.signal] }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getInput).not.toHaveBeenCalled();
  });
});
