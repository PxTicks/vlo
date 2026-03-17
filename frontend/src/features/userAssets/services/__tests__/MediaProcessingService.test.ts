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
} from "../MediaProcessingService";
import { Input } from "mediabunny";

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

  return {
    Input: MockInput,
    BlobSource: vi.fn(),
    ALL_FORMATS: [],
    Mp4OutputFormat: vi.fn(),
    BufferTarget: vi.fn(),
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
