import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaSecondsToTick } from "../../../../core/time";
import {
  extractAssetFrameFile,
  extractAssetRangeFile,
} from "../AssetExtractionService";

const mocks = vi.hoisted(() => ({
  conversionOptions: null as unknown,
  dispose: vi.fn(),
  execute: vi.fn(async () => undefined),
  captureFrame: vi.fn(async () =>
    new File(["png"], "source-frame.png", { type: "image/png" }),
  ),
}));

vi.mock("../../../../core/media", () => ({
  captureVideoFrameFile: mocks.captureFrame,
}));

vi.mock("mediabunny", () => {
  class MockBufferTarget {
    buffer: ArrayBuffer | null = new Uint8Array([1, 2, 3]).buffer;
  }

  class MockInput {
    dispose = mocks.dispose;
    getPrimaryAudioTrack = vi.fn(async () => ({ id: "audio-1", codec: "mp3" }));
  }

  class MockOutput {
    target: MockBufferTarget;

    constructor(options: { target: MockBufferTarget }) {
      this.target = options.target;
    }
  }

  return {
    ALL_FORMATS: [],
    BlobSource: class {},
    BufferTarget: MockBufferTarget,
    Conversion: {
      init: vi.fn(async (options: unknown) => {
        mocks.conversionOptions = options;
        return { isValid: true, execute: mocks.execute };
      }),
    },
    Input: MockInput,
    FlacOutputFormat: class {},
    Mp3OutputFormat: class {},
    Mp4OutputFormat: class {},
    OggOutputFormat: class {},
    Output: MockOutput,
    OutputFormat: class {},
    WavOutputFormat: class {},
  };
});

function source(mediaType: "video" | "audio") {
  return {
    sourceFile: new File(
      ["media"],
      `source.${mediaType === "video" ? "mov" : "mp3"}`,
    ),
    mediaType,
  };
}

describe("AssetExtractionService", () => {
  beforeEach(() => {
    mocks.conversionOptions = null;
    mocks.dispose.mockClear();
    mocks.execute.mockClear();
    mocks.captureFrame.mockClear();
  });

  it("trims a video range into an MP4 file", async () => {
    const file = await extractAssetRangeFile(
      source("video"),
      mediaSecondsToTick(1.25),
      mediaSecondsToTick(4.5),
    );

    expect(file.name).toBe("source-excerpt.mp4");
    expect(file.type).toBe("video/mp4");
    expect(mocks.conversionOptions).toMatchObject({
      trim: { start: 1.25, end: 4.5 },
      showWarnings: false,
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("trims audio without retaining video tracks", async () => {
    const file = await extractAssetRangeFile(
      source("audio"),
      mediaSecondsToTick(2),
      mediaSecondsToTick(3),
    );

    expect(file.name).toBe("source-excerpt.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(mocks.conversionOptions).toMatchObject({
      trim: { start: 2, end: 3 },
      video: { discard: true },
    });
    const audio = (
      mocks.conversionOptions as {
        audio: (track: { id: string }) => unknown;
      }
    ).audio;
    expect(audio({ id: "audio-1" })).toEqual({ codec: "mp3" });
    expect(audio({ id: "audio-2" })).toEqual({ discard: true });
  });

  it("captures a video frame through the shared robust frame service", async () => {
    const resolvedSource = {
      sourceUrl: "blob:source",
      sourceFilename: "source.mov",
    };

    const file = await extractAssetFrameFile(
      resolvedSource,
      mediaSecondsToTick(1.5),
    );

    expect(file.name).toBe("source-frame.png");
    expect(mocks.captureFrame).toHaveBeenCalledWith(
      resolvedSource.sourceUrl,
      1.5,
      "source-frame.png",
    );
  });
});
