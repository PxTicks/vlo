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
import { CanvasSink, Input } from "mediabunny";

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
    vi.mocked(Input).mockImplementationOnce(function () {
      return {
        getMimeType: vi.fn(),
        computeDuration,
        getPrimaryVideoTrack: vi.fn(),
        getPrimaryAudioTrack: vi.fn(),
        dispose: vi.fn(),
      };
    });

    await expect(processor.computeDuration()).resolves.toBe(12.5);
    expect(computeDuration).toHaveBeenCalled();
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
});
