import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  MediaProcessingService,
  MediaFileProcessor,
  resolvePrimaryAudioOutputSpec,
} from "../MediaProcessingService";
import { BufferTarget, CanvasSink, Conversion, Input, Output } from "mediabunny";

// Mock mediabunny
vi.mock("mediabunny", () => {
  const MockInput = vi.fn(function () {
    return {
      getMimeType: vi.fn(),
      computeDuration: vi.fn(),
      getPrimaryVideoTrack: vi.fn(),
      getPrimaryAudioTrack: vi.fn(),
      dispose: vi.fn(),
    };
  });
  const MockCanvasSink = vi.fn(function () {
    return {
      canvases: vi.fn(() => ({
        next: vi.fn().mockResolvedValue({ value: undefined }),
        return: vi.fn().mockResolvedValue(undefined),
      })),
    };
  });

  return {
    Input: MockInput,
    BlobSource: vi.fn(),
    ALL_FORMATS: [],
    CanvasSink: MockCanvasSink,
    Output: vi.fn(function ({ format, target }) {
      const mimeType =
        format?.kind === "wav"
          ? "audio/wav"
          : format?.kind === "mp3"
            ? "audio/mpeg"
            : format?.kind === "flac"
              ? "audio/flac"
              : format?.kind === "ogg"
                ? "audio/ogg"
                : "audio/mp4";
      return {
        target,
        getMimeType: vi.fn().mockResolvedValue(mimeType),
      };
    }),
    OggOutputFormat: vi.fn(function () {
      return { kind: "ogg" };
    }),
    FlacOutputFormat: vi.fn(function () {
      return { kind: "flac" };
    }),
    Mp3OutputFormat: vi.fn(function () {
      return { kind: "mp3" };
    }),
    Mp4OutputFormat: vi.fn(function () {
      return { kind: "mp4" };
    }),
    WavOutputFormat: vi.fn(function () {
      return { kind: "wav" };
    }),
    BufferTarget: vi.fn(function () {
      return {
        buffer: new Uint8Array([1, 2, 3]),
      };
    }),
    Conversion: {
      init: vi.fn(),
    },
  };
});

// Mock xxhash-wasm
vi.mock("xxhash-wasm", () => ({
  default: vi.fn(() => ({
    create64: vi.fn(() => ({
      update: vi.fn(),
      digest: vi.fn(() => ({ toString: () => "mock-hash" })),
    })),
  })),
}));

describe("MediaFileProcessor", () => {
  let file: File;
  let processor: MediaFileProcessor;

  beforeEach(() => {
    file = new File(["dummy content"], "test.mp4", { type: "video/mp4" });
    processor = new MediaFileProcessor(file);
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Safety dispose if test didn't
    try {
      processor.dispose();
    } catch {
      // ignore
    }
  });

  it("should lazy load Input only when needed", async () => {
    expect(Input).not.toHaveBeenCalled();
    await processor.detectMimeType();
    expect(Input).toHaveBeenCalledTimes(1);
    await processor.detectMimeType();
    expect(Input).toHaveBeenCalledTimes(1); // Should reuse input
  });

  it("should dispose the input when dispose is called", async () => {
    await processor.detectMimeType();

    // Get the instance created by the NEW call inside detectMimeType
    // The Input mock function returns the mock object.
    const inputMockInstance = vi.mocked(Input).mock.results[0].value;

    expect(inputMockInstance.dispose).toBeDefined();

    processor.dispose();
    expect(inputMockInstance.dispose).toHaveBeenCalled();
  });

  it("should throw error if used after disposal", async () => {
    // We don't need to initialize input to test disposal check
    processor.dispose();

    // Now it should throw immediately because we added explicit check
    await expect(processor.detectMimeType()).rejects.toThrow(
      "MediaFileProcessor is disposed",
    );
    await expect(processor.computeDuration()).rejects.toThrow(
      "MediaFileProcessor is disposed",
    );
    await expect(processor.generateVideoMetadata()).rejects.toThrow(
      "MediaFileProcessor is disposed",
    );
    await expect(processor.generateProxyVideo()).rejects.toThrow(
      "MediaFileProcessor is disposed",
    );
    await expect(processor.hasAudioTrack()).rejects.toThrow(
      "MediaFileProcessor is disposed",
    );
  });

  it("should detect audio track", async () => {
    const getPrimaryAudioTrack = vi.fn().mockResolvedValue({});
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: getPrimaryAudioTrack,
        dispose: vi.fn(),
      };
    });

    const result = await processor.hasAudioTrack();
    expect(result).toBe(true);
    expect(getPrimaryAudioTrack).toHaveBeenCalled();
  });

  it("should return false if no audio track", async () => {
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: vi.fn().mockResolvedValue(null),
        dispose: vi.fn(),
      };
    });

    const result = await processor.hasAudioTrack();
    expect(result).toBe(false);
  });

  it("should resolve output specs that preserve common source codecs", () => {
    expect(resolvePrimaryAudioOutputSpec("aac")).toMatchObject({
      extension: "m4a",
      mimeType: "audio/mp4",
    });
    expect(resolvePrimaryAudioOutputSpec("opus")).toMatchObject({
      extension: "ogg",
      mimeType: "audio/ogg",
    });
    expect(resolvePrimaryAudioOutputSpec("pcm-s16")).toMatchObject({
      extension: "wav",
      mimeType: "audio/wav",
    });
    expect(resolvePrimaryAudioOutputSpec("mystery-codec")).toBeNull();
  });

  it("should compute media duration", async () => {
    const computeDuration = vi.fn().mockResolvedValue(12.5);
    const getPrimaryVideoTrack = vi.fn().mockResolvedValue({
      computeDuration: vi.fn().mockResolvedValue(5),
      getFirstTimestamp: vi.fn().mockRejectedValue(new Error("probe failed")),
    });
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration,
        getPrimaryVideoTrack,
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });

    await expect(processor.computeDuration()).resolves.toBe(12.5);
    expect(computeDuration).toHaveBeenCalledOnce();
    expect(getPrimaryVideoTrack).not.toHaveBeenCalled();
  });

  it("falls back safely for MIME and duration probe failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(Input)
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn().mockResolvedValue(""),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn().mockRejectedValue(new Error("probe failed")),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn().mockResolvedValue(Number.NaN),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn().mockRejectedValue(new Error("duration failed")),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      });

    const emptyMime = new MediaFileProcessor(
      new File(["x"], "fallback.mp4", { type: "video/mp4" }),
    );
    await expect(emptyMime.detectMimeType()).resolves.toBe("video/mp4");
    const failedMime = new MediaFileProcessor(
      new File(["x"], "fallback.wav", { type: "audio/wav" }),
    );
    await expect(failedMime.detectMimeType()).resolves.toBe("audio/wav");
    const invalidDuration = new MediaFileProcessor(file);
    await expect(invalidDuration.computeDuration()).resolves.toBe(0);
    const failedDuration = new MediaFileProcessor(file);
    await expect(failedDuration.computeDuration()).resolves.toBe(0);
    warning.mockRestore();
  });

  it("should extract the primary audio track without timeline rendering", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: vi.fn().mockResolvedValue({
          id: "audio-1",
          codec: "aac",
        }),
        dispose: vi.fn(),
      };
    });
    const { Conversion } = await import("mediabunny");
    vi.mocked(Conversion.init).mockResolvedValue({ execute } as never);

    const extracted = await processor.extractPrimaryAudioTrack();

    expect(extracted).toBeInstanceOf(File);
    expect(extracted?.name).toBe("test-audio.m4a");
    expect(extracted?.type).toBe("audio/mp4");
    expect(Conversion.init).toHaveBeenCalledWith(
      expect.objectContaining({
        video: { discard: true },
        showWarnings: false,
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("should fall back to wav extraction when the primary track codec is unavailable", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: vi.fn().mockResolvedValue({
          id: "audio-1",
          codec: undefined,
        }),
        dispose: vi.fn(),
      };
    });
    const { Conversion } = await import("mediabunny");
    vi.mocked(Conversion.init).mockResolvedValue({ execute } as never);

    const extracted = await processor.extractPrimaryAudioTrack();

    expect(extracted).toBeInstanceOf(File);
    expect(extracted?.name).toBe("test-audio.wav");
    expect(extracted?.type).toBe("audio/wav");
    const conversionConfig = vi.mocked(Conversion.init).mock.calls[0]?.[0];
    const audioCallback = conversionConfig?.audio as
      | ((track: { id: string }, index: number) => unknown)
      | undefined;
    expect(audioCallback?.({ id: "audio-1" }, 1)).toEqual({
      codec: "pcm-s16",
    });
    expect(audioCallback?.({ id: "audio-2" }, 2)).toEqual({
      discard: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns null when audio extraction has no primary track or output buffer", async () => {
    vi.mocked(Input)
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn().mockResolvedValue(null),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn(),
          getPrimaryAudioTrack: vi.fn().mockResolvedValue({
            id: "audio-1",
            codec: "aac",
            sampleRate: 48000,
            numberOfChannels: 2,
          }),
          dispose: vi.fn(),
        };
      });
    const noTrack = new MediaFileProcessor(file);
    await expect(noTrack.extractPrimaryAudioTrack()).resolves.toBeNull();

    vi.mocked(BufferTarget).mockImplementationOnce(function () {
      return { buffer: null };
    });
    vi.mocked(Conversion.init).mockResolvedValueOnce({
      execute: vi.fn().mockResolvedValue(undefined),
    } as never);
    const noBuffer = new MediaFileProcessor(file);
    await expect(noBuffer.extractPrimaryAudioTrack()).resolves.toBeNull();
  });

  it("uses the planned MIME type when the output cannot report one", async () => {
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: vi.fn().mockResolvedValue({
          id: "audio-1",
          codec: "opus",
        }),
        dispose: vi.fn(),
      };
    });
    vi.mocked(Output).mockImplementationOnce(function ({ target }) {
      return { target };
    });
    vi.mocked(Conversion.init).mockResolvedValueOnce({
      execute: vi.fn().mockResolvedValue(undefined),
    } as never);
    const extracted = await new MediaFileProcessor(file).extractPrimaryAudioTrack();
    expect(extracted?.type).toBe("audio/ogg");
    expect(extracted?.name).toBe("test-audio.ogg");
  });

  it("should prefer primary video track duration when generating video metadata", async () => {
    const computeDuration = vi.fn().mockResolvedValue(12.041678004535147);
    const trackComputeDuration = vi.fn().mockResolvedValue(12.041666666666666);
    const computePacketStats = vi.fn().mockResolvedValue({
      averagePacketRate: 24,
    });
    const getFirstTimestamp = vi.fn().mockResolvedValue(0);

    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration,
        getPrimaryVideoTrack: vi.fn().mockResolvedValue({
          computeDuration: trackComputeDuration,
          computePacketStats,
          displayWidth: 1920,
          displayHeight: 1080,
          getFirstTimestamp,
        }),
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });
    vi.mocked(CanvasSink).mockImplementationOnce(function () {
      return {
        canvases: vi.fn(() => ({
          next: vi.fn().mockResolvedValue({ value: undefined }),
          return: vi.fn().mockResolvedValue(undefined),
        })),
      };
    });

    const metadata = await processor.generateVideoMetadata();

    expect(metadata.duration).toBe(12.041666666666666);
    expect(metadata.fps).toBe(24);
    expect(trackComputeDuration).toHaveBeenCalledTimes(1);
    expect(computeDuration).not.toHaveBeenCalled();
  });

  it("uses the true track span when choosing a thumbnail timestamp", async () => {
    const canvases = vi.fn(() => ({
      next: vi.fn().mockResolvedValue({ value: undefined }),
      return: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn().mockResolvedValue({
          computeDuration: vi.fn().mockResolvedValue(3),
          getFirstTimestamp: vi.fn().mockResolvedValue(2),
          computePacketStats: vi.fn().mockResolvedValue({
            averagePacketRate: 30,
          }),
          displayWidth: 1920,
          displayHeight: 1080,
        }),
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });
    vi.mocked(CanvasSink).mockImplementationOnce(function () {
      return { canvases };
    });

    const metadata = await processor.generateVideoMetadata();

    // Timeline source ticks remain zero-anchored, so the extent is the end
    // timestamp; the representative frame is halfway through the true span.
    expect(metadata.duration).toBe(3);
    expect(canvases).toHaveBeenCalledWith(2.5);
  });

  it("falls back to container duration and tolerates track diagnostics failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const iteratorReturn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn().mockResolvedValue(5),
        getPrimaryVideoTrack: vi.fn().mockResolvedValue({
          computeDuration: vi.fn().mockRejectedValue(new Error("bad track duration")),
          computePacketStats: vi.fn().mockRejectedValue(new Error("bad stats")),
          displayWidth: 100,
          displayHeight: 200,
          getFirstTimestamp: vi.fn().mockRejectedValue(new Error("no timestamp")),
        }),
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });
    vi.mocked(CanvasSink).mockImplementationOnce(function (_track, options) {
      expect(options).toMatchObject({ height: 320, poolSize: 1 });
      return {
        canvases: vi.fn(() => ({
          next: vi.fn().mockResolvedValue({ value: undefined }),
          return: iteratorReturn,
        })),
      };
    });

    await expect(
      new MediaFileProcessor(file).generateVideoMetadata(),
    ).resolves.toEqual({
      thumbnail: null,
      duration: 5,
      fps: null,
    });
    expect(iteratorReturn).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("returns empty metadata when the video probe fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration: vi.fn(),
        getPrimaryVideoTrack: vi.fn().mockRejectedValue(new Error("broken")),
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });
    await expect(
      new MediaFileProcessor(file).generateVideoMetadata(),
    ).resolves.toEqual({
      thumbnail: null,
      duration: 0,
      fps: null,
    });
    error.mockRestore();
  });

  it("generates proxy video and handles absent tracks and conversion failures", async () => {
    vi.mocked(Input)
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn().mockResolvedValue(null),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn().mockResolvedValue({ id: "video-1" }),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      })
      .mockImplementationOnce(function () {
        return {
          getMimeType: vi.fn(),
          computeDuration: vi.fn(),
          getPrimaryVideoTrack: vi.fn().mockResolvedValue({ id: "video-1" }),
          getPrimaryAudioTrack: vi.fn(),
          dispose: vi.fn(),
        };
      });
    await expect(
      new MediaFileProcessor(file).generateProxyVideo(),
    ).resolves.toBeNull();

    vi.mocked(Conversion.init).mockResolvedValueOnce({
      execute: vi.fn().mockResolvedValue(undefined),
    } as never);
    await expect(
      new MediaFileProcessor(file).generateProxyVideo(),
    ).resolves.toEqual(expect.any(Blob));

    vi.mocked(Conversion.init).mockRejectedValueOnce(new Error("conversion failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      new MediaFileProcessor(file).generateProxyVideo(),
    ).resolves.toBeNull();
    error.mockRestore();
  });
});

describe("MediaProcessingService", () => {
  const service = new MediaProcessingService();

  it("should create a processor", () => {
    const file = new File([], "test.mp4");
    const processor = service.createProcessor(file);
    expect(processor).toBeInstanceOf(MediaFileProcessor);
  });

  it("should sanitize filenames", () => {
    expect(service.sanitizeFilename("foo/bar.txt")).toBe("foo_bar.txt");
    expect(service.sanitizeFilename("..foo..")).toBe("foo");
    expect(service.sanitizeFilename("Microsoft\u200B Edge.mp4")).toBe(
      "Microsoft Edge.mp4",
    );
    expect(service.sanitizeFilename("CON.txt")).toBe("CON_file.txt");
  });

  it("should cap sanitized filenames to leave room for derived asset files", () => {
    const sanitized = service.sanitizeFilename(`${"a".repeat(220)}.mp4`);

    expect(sanitized.endsWith(".mp4")).toBe(true);
    expect(sanitized.length).toBeLessThanOrEqual(180);
  });

  it("generates landscape and portrait image thumbnails", async () => {
    const drawImage = vi.fn();
    const convertToBlob = vi
      .fn()
      .mockResolvedValue(new Blob(["thumb"], { type: "image/webp" }));
    const OffscreenCanvasMock = vi.fn(function (
      width: number,
      height: number,
    ) {
      return {
        width,
        height,
        getContext: vi.fn(() => ({ drawImage })),
        convertToBlob,
      };
    });
    vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({ width: 640, height: 320 })
        .mockResolvedValueOnce({ width: 100, height: 400 }),
    );

    await expect(
      service.generateImageThumbnail(new File(["image"], "wide.png")),
    ).resolves.toEqual(expect.any(Blob));
    expect(OffscreenCanvasMock).toHaveBeenNthCalledWith(1, 320, 160);
    await service.generateImageThumbnail(new File(["image"], "tall.png"));
    expect(OffscreenCanvasMock).toHaveBeenNthCalledWith(2, 80, 320);
    expect(drawImage).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("rejects image thumbnails without a 2d context", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
    }));
    vi.stubGlobal(
      "OffscreenCanvas",
      vi.fn(function () {
        return { getContext: vi.fn(() => null) };
      }),
    );
    await expect(
      service.generateImageThumbnail(new File(["image"], "bad.png")),
    ).rejects.toThrow("Could not get canvas context");
    vi.unstubAllGlobals();
  });

  it("disposes processors used by every convenience wrapper", async () => {
    const processor = {
      detectMimeType: vi.fn().mockResolvedValue("video/mp4"),
      computeDuration: vi.fn().mockResolvedValue(2),
      generateVideoMetadata: vi.fn().mockResolvedValue({
        thumbnail: null,
        duration: 2,
        fps: 30,
      }),
      generateProxyVideo: vi.fn().mockResolvedValue(new Blob()),
      hasAudioTrack: vi.fn().mockResolvedValue(true),
      extractPrimaryAudioTrack: vi.fn().mockResolvedValue(new File([], "audio.wav")),
      dispose: vi.fn(),
    };
    vi.spyOn(service, "createProcessor").mockReturnValue(processor as never);
    const source = new File([], "source.mp4");

    await service.detectMimeType(source);
    await service.computeDuration(source);
    await service.generateVideoMetadata(source);
    await service.generateProxyVideo(source);
    await service.hasAudioTrack(source);
    await service.extractPrimaryAudioTrack(source);

    expect(processor.dispose).toHaveBeenCalledTimes(6);
  });
});
