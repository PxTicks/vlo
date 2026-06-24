import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockVideoTrack {
  codedWidth: number;
  codedHeight: number;
  computeDuration: ReturnType<typeof vi.fn>;
}

interface MockAudioTrack {
  codec?: string | null;
  computeDuration: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  videoTrack: null as MockVideoTrack | null,
  audioTrack: null as MockAudioTrack | null,
  videoSamples: [] as Array<{
    timestamp: number;
    duration: number;
    draw: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  audioBuffers: [] as Array<{
    buffer: AudioBuffer;
    timestamp: number;
    duration: number;
  }>,
  canvasContexts: [] as Array<object | null>,
  target: { buffer: new Uint8Array([1, 2, 3]) as Uint8Array | null },
  outputMimeType: "mock" as "mock" | "missing",
  input: {
    getPrimaryVideoTrack: vi.fn(),
    getPrimaryAudioTrack: vi.fn(),
    dispose: vi.fn(),
  },
  output: {
    addVideoTrack: vi.fn(),
    addAudioTrack: vi.fn(),
    start: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    getMimeType: vi.fn(async () => "application/mock"),
    target: null as unknown,
  },
  videoSource: {
    add: vi.fn(async () => undefined),
    close: vi.fn(),
  },
  audioSource: {
    add: vi.fn(async () => undefined),
    close: vi.fn(),
  },
  createdVideoSamples: [] as Array<{
    canvas: unknown;
    options: { timestamp: number; duration: number };
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: ["all"],
  QUALITY_HIGH: 1,
  BlobSource: vi.fn(function (file: File) {
    return { file };
  }),
  BufferTarget: vi.fn(function () {
    return mocks.target;
  }),
  Input: vi.fn(function () {
    mocks.input.getPrimaryVideoTrack.mockImplementation(async () => mocks.videoTrack);
    mocks.input.getPrimaryAudioTrack.mockImplementation(async () => mocks.audioTrack);
    return mocks.input;
  }),
  VideoSampleSink: vi.fn(function () {
    return {
      samples: async function* () {
        yield* mocks.videoSamples;
      },
    };
  }),
  AudioBufferSink: vi.fn(function () {
    return {
      buffers: async function* () {
        yield* mocks.audioBuffers;
      },
    };
  }),
  Output: vi.fn(function () {
    mocks.output.target = mocks.target;
    if (mocks.outputMimeType === "missing") {
      return {
        ...mocks.output,
        getMimeType: undefined,
      };
    }
    return mocks.output;
  }),
  Mp4OutputFormat: vi.fn(function () {
    return { kind: "mp4" };
  }),
  Mp3OutputFormat: vi.fn(function () {
    return { kind: "mp3" };
  }),
  WavOutputFormat: vi.fn(function () {
    return { kind: "wav" };
  }),
  VideoSampleSource: vi.fn(function () {
    return mocks.videoSource;
  }),
  AudioBufferSource: vi.fn(function () {
    return mocks.audioSource;
  }),
  VideoSample: vi.fn(function (
    canvas: unknown,
    options: { timestamp: number; duration: number },
  ) {
    const sample = { canvas, options, close: vi.fn() };
    mocks.createdVideoSamples.push(sample);
    return sample;
  }),
}));

import {
  AudioBufferSource,
  Mp3OutputFormat,
  Mp4OutputFormat,
  VideoSampleSource,
  WavOutputFormat,
} from "mediabunny";
import { reverseAssetFile } from "../AssetReversalService";

function videoTrack(
  codedWidth = 640,
  codedHeight = 360,
  duration = 2,
): MockVideoTrack {
  return {
    codedWidth,
    codedHeight,
    computeDuration: vi.fn(async () => duration),
  };
}

function audioTrack(codec: string | null = "aac", duration = 1): MockAudioTrack {
  return {
    codec,
    computeDuration: vi.fn(async () => duration),
  };
}

function videoSample(timestamp: number, duration: number) {
  return {
    timestamp,
    duration,
    draw: vi.fn(),
    close: vi.fn(),
  };
}

function audioBuffer(channels: number[][], sampleRate = 4): AudioBuffer {
  const channelData = channels.map((channel) => new Float32Array(channel));
  return {
    length: channelData[0]?.length ?? 0,
    duration: (channelData[0]?.length ?? 0) / sampleRate,
    sampleRate,
    numberOfChannels: channelData.length,
    copyFromChannel(destination: Float32Array, channelNumber: number) {
      destination.set(channelData[channelNumber]);
    },
  } as unknown as AudioBuffer;
}

function installCanvasAndAudioMocks() {
  vi.stubGlobal(
    "OffscreenCanvas",
    vi.fn(function () {
      const context =
        mocks.canvasContexts.length > 0 ? mocks.canvasContexts.shift() : {};
      return {
        getContext: vi.fn(() => context),
      };
    }),
  );
  vi.stubGlobal(
    "OfflineAudioContext",
    vi.fn(function () {
      return {
        createBuffer: vi.fn(
          (
            numberOfChannels: number,
            length: number,
            sampleRate: number,
          ) => {
            const copied: Float32Array[] = Array.from(
              { length: numberOfChannels },
              () => new Float32Array(length),
            );
            return {
              length,
              sampleRate,
              numberOfChannels,
              copyToChannel: vi.fn(
                (source: Float32Array, channelNumber: number) => {
                  copied[channelNumber].set(source);
                },
              ),
              copied,
            };
          },
        ),
      };
    }),
  );
}

describe("reverseAssetFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.videoTrack = null;
    mocks.audioTrack = null;
    mocks.videoSamples = [];
    mocks.audioBuffers = [];
    mocks.canvasContexts = [];
    mocks.target.buffer = new Uint8Array([1, 2, 3]);
    mocks.outputMimeType = "mock";
    mocks.createdVideoSamples = [];
    installCanvasAndAudioMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects media without usable tracks and always disposes input", async () => {
    await expect(
      reverseAssetFile(new File(["empty"], "empty.bin")),
    ).rejects.toThrow("Source media has no usable video or audio track");
    expect(mocks.input.dispose).toHaveBeenCalled();
  });

  it("reverses video frames, preserves durations, and reports progress", async () => {
    mocks.videoTrack = videoTrack(640, 360, 3);
    mocks.videoSamples = [videoSample(0, 1), videoSample(1, 2)];
    mocks.canvasContexts = [{}, {}];
    const onProgress = vi.fn();

    const result = await reverseAssetFile(
      new File(["video"], "My: Clip.MOV", { type: "video/quicktime" }),
      { onProgress },
    );

    expect(result).toMatchObject({ hadVideo: true, hadAudio: false });
    expect(result.file.name).toBe("My_ Clip-reversed.mp4");
    expect(result.file.type).toBe("application/mock");
    expect(Mp4OutputFormat).toHaveBeenCalled();
    expect(VideoSampleSource).toHaveBeenCalledWith({
      codec: "avc",
      bitrate: 1,
    });
    expect(mocks.createdVideoSamples.map((sample) => sample.options)).toEqual([
      { timestamp: 0, duration: 2 },
      { timestamp: 2, duration: 1 },
    ]);
    const videoAddCalls = mocks.videoSource.add.mock.calls as unknown as Array<
      [unknown, { keyFrame: boolean }]
    >;
    expect(videoAddCalls[0]?.[1]).toEqual({ keyFrame: true });
    expect(videoAddCalls[1]?.[1]).toEqual({ keyFrame: false });
    expect(mocks.createdVideoSamples.every((sample) =>
      sample.close.mock.calls.length === 1,
    )).toBe(true);
    expect(mocks.videoSamples.every((sample) =>
      sample.close.mock.calls.length === 1,
    )).toBe(true);
    expect(onProgress).toHaveBeenCalledWith({
      stage: "decode-video",
      fraction: 1,
    });
    expect(onProgress).toHaveBeenCalledWith({
      stage: "encode",
      fraction: 1,
    });
    expect(onProgress).toHaveBeenCalledWith({
      stage: "finalize",
      fraction: 0,
    });
    expect(onProgress).toHaveBeenCalledWith({
      stage: "finalize",
      fraction: 1,
    });
  });

  it("skips video samples when a 2D context cannot be acquired", async () => {
    mocks.videoTrack = videoTrack();
    mocks.videoSamples = [videoSample(0, 1), videoSample(1, 1)];
    mocks.canvasContexts = [null, {}];

    const result = await reverseAssetFile(
      new File(["video"], "clip.mp4"),
    );

    expect(result.hadVideo).toBe(true);
    expect(mocks.videoSamples[0].draw).not.toHaveBeenCalled();
    expect(mocks.videoSamples[0].close).toHaveBeenCalled();
    expect(mocks.videoSamples[1].draw).toHaveBeenCalled();
  });

  it("uses MP3 for MP3-only audio and reverses channel samples", async () => {
    mocks.audioTrack = audioTrack("mp3", 1);
    mocks.audioBuffers = [
      {
        buffer: audioBuffer([
          [1, 2],
          [3, 4],
        ]),
        timestamp: 0,
        duration: 0.5,
      },
      {
        buffer: audioBuffer([[5, 6]]),
        timestamp: 0.5,
        duration: 0.5,
      },
    ];
    const onProgress = vi.fn();

    const result = await reverseAssetFile(
      new File(["audio"], "voice.mp3", { type: "audio/mpeg" }),
      { onProgress },
    );

    expect(result).toMatchObject({ hadVideo: false, hadAudio: true });
    expect(result.file.name).toBe("voice-reversed.mp3");
    expect(Mp3OutputFormat).toHaveBeenCalled();
    expect(AudioBufferSource).toHaveBeenCalledWith({
      codec: "mp3",
      bitrate: 1,
    });
    const encodedBuffer = (
      mocks.audioSource.add.mock.calls as unknown as Array<
        [{ copied: Float32Array[] }]
      >
    )[0]?.[0] as unknown as {
      copied: Float32Array[];
    };
    expect([...encodedBuffer.copied[0]]).toEqual([6, 5, 2, 1]);
    expect([...encodedBuffer.copied[1]]).toEqual([0, 0, 4, 3]);
    expect(onProgress).toHaveBeenCalledWith({
      stage: "decode-audio",
      fraction: 1,
    });
  });

  it.each([
    ["pcm-s16", WavOutputFormat, "wav", "audio/wav", "pcm-s16"],
    ["mystery", Mp4OutputFormat, "m4a", "audio/mp4", "aac"],
    [null, Mp4OutputFormat, "m4a", "audio/mp4", "aac"],
  ])(
    "selects a compatible audio container for %s",
    async (codec, Format, extension, mimeType, encodingCodec) => {
      mocks.audioTrack = audioTrack(codec);
      mocks.audioBuffers = [
        {
          buffer: audioBuffer([[1, 2]]),
          timestamp: 0,
          duration: 0.5,
        },
      ];
      mocks.outputMimeType = "missing";

      const result = await reverseAssetFile(
        new File(["audio"], "voice.source"),
      );

      expect(Format).toHaveBeenCalled();
      expect(result.file.name).toBe(`voice-reversed.${extension}`);
      expect(result.file.type).toBe(mimeType);
      expect(AudioBufferSource).toHaveBeenCalledWith({
        codec: encodingCodec,
        bitrate: 1,
      });
    },
  );

  it("encodes combined video and audio into MP4 with weighted progress", async () => {
    mocks.videoTrack = videoTrack(100, 50, 1);
    mocks.audioTrack = audioTrack("mp3", 1);
    mocks.videoSamples = [videoSample(0, 1)];
    mocks.audioBuffers = [
      {
        buffer: audioBuffer([[1, 2, 3, 4]]),
        timestamp: 0,
        duration: 1,
      },
    ];
    mocks.canvasContexts = [{}];
    const onProgress = vi.fn();

    const result = await reverseAssetFile(
      new File(["media"], "combined.webm"),
      { onProgress },
    );

    expect(result).toMatchObject({ hadVideo: true, hadAudio: true });
    expect(result.file.name).toBe("combined-reversed.mp4");
    expect(Mp4OutputFormat).toHaveBeenCalled();
    expect(mocks.output.addVideoTrack).toHaveBeenCalledWith(mocks.videoSource);
    expect(mocks.output.addAudioTrack).toHaveBeenCalledWith(mocks.audioSource);
    expect(onProgress).toHaveBeenCalledWith({
      stage: "encode",
      fraction: 0.5,
    });
    expect(onProgress).toHaveBeenCalledWith({
      stage: "encode",
      fraction: 1,
    });
  });

  it("treats invalid dimensions and empty audio buffers as unusable", async () => {
    mocks.videoTrack = videoTrack(0, 360);
    mocks.audioTrack = audioTrack();
    mocks.audioBuffers = [
      {
        buffer: audioBuffer([[]]),
        timestamp: 0,
        duration: 0,
      },
    ];

    await expect(
      reverseAssetFile(new File(["bad"], "bad.media")),
    ).rejects.toThrow("no usable video or audio");
  });

  it("requires OfflineAudioContext for audio encoding", async () => {
    mocks.audioTrack = audioTrack();
    mocks.audioBuffers = [
      {
        buffer: audioBuffer([[1, 2]]),
        timestamp: 0,
        duration: 0.5,
      },
    ];
    vi.stubGlobal("OfflineAudioContext", undefined);

    await expect(
      reverseAssetFile(new File(["audio"], "audio.m4a")),
    ).rejects.toThrow("OfflineAudioContext unavailable");
    expect(mocks.input.dispose).toHaveBeenCalled();
  });

  it("rejects a finalized output with no buffer", async () => {
    mocks.videoTrack = videoTrack();
    mocks.videoSamples = [videoSample(0, 1)];
    mocks.canvasContexts = [{}];
    mocks.target.buffer = null;

    await expect(
      reverseAssetFile(new File(["video"], "clip.mp4")),
    ).rejects.toThrow("Reversal completed without an output buffer");
    expect(mocks.output.finalize).toHaveBeenCalled();
    expect(mocks.input.dispose).toHaveBeenCalled();
  });
});
