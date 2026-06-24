import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutputCanvas,
  cropImageToAspectRatio,
  cropVideoToAspectRatio,
  convertCanvasToBlob,
  isCanvas2DContext,
  maybeCropVisualFileToAspectRatio,
  maybeResizeVisualFile,
  normalizeToSupportedProjectAspectRatio,
  probeVisualFileAspectRatio,
  resizeImageToExactDimensions,
  resizeVideoToExactDimensions,
  resolveImageOutputMimeType,
  resolveResizeTarget,
  resolveVideoOutputContainer,
} from "../media";
import type { AspectRatioProcessingMetadata } from "../../../types";

const mediaMocks = vi.hoisted(() => ({
  primaryVideoTrack: null as null | {
    displayWidth: number;
    displayHeight: number;
  },
  outputBuffer: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer | null,
  getPrimaryVideoTrack: vi.fn(),
  dispose: vi.fn(),
  execute: vi.fn(),
  conversionInit: vi.fn(),
}));

vi.mock("mediabunny", () => {
  class Input {
    getPrimaryVideoTrack = mediaMocks.getPrimaryVideoTrack;
    dispose = mediaMocks.dispose;
  }
  class BufferTarget {
    buffer = mediaMocks.outputBuffer;
  }
  class Output {}
  class BlobSource {}
  class Mp4OutputFormat {}
  return {
    ALL_FORMATS: [],
    Input,
    BufferTarget,
    Output,
    BlobSource,
    Mp4OutputFormat,
    Conversion: {
      init: mediaMocks.conversionInit,
    },
  };
});

function imageFile(name = "frame.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function probeableVideoFile(name = "source.webm"): File {
  const file = new File(["video"], name, { type: "video/mp4" });
  vi.spyOn(file, "slice").mockReturnValue({
    arrayBuffer: async () => new ArrayBuffer(1),
  } as Blob);
  return file;
}

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  return { close };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mediaMocks.primaryVideoTrack = null;
  mediaMocks.outputBuffer = new Uint8Array([1, 2, 3]).buffer;
  mediaMocks.getPrimaryVideoTrack.mockReset();
  mediaMocks.getPrimaryVideoTrack.mockImplementation(
    async () => mediaMocks.primaryVideoTrack,
  );
  mediaMocks.dispose.mockReset();
  mediaMocks.execute.mockReset();
  mediaMocks.conversionInit.mockReset();
  mediaMocks.conversionInit.mockImplementation(async () => ({
    execute: mediaMocks.execute,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveResizeTarget", () => {
  const base = {
    enabled: true,
    postprocess: {
      enabled: true,
      mode: "stretch_exact",
      apply_to: "all_visual_outputs",
      target_width: 640,
      target_height: 480,
    },
  } as unknown as AspectRatioProcessingMetadata;

  it("returns the target when fully configured", () => {
    expect(resolveResizeTarget(base)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for each disabling condition", () => {
    expect(resolveResizeTarget(null)).toBeNull();
    expect(resolveResizeTarget(undefined)).toBeNull();
    expect(
      resolveResizeTarget({ ...base, enabled: false } as AspectRatioProcessingMetadata),
    ).toBeNull();
    expect(
      resolveResizeTarget({
        ...base,
        postprocess: undefined,
      } as unknown as AspectRatioProcessingMetadata),
    ).toBeNull();
    expect(
      resolveResizeTarget({
        ...base,
        postprocess: { ...base.postprocess, enabled: false },
      } as unknown as AspectRatioProcessingMetadata),
    ).toBeNull();
    expect(
      resolveResizeTarget({
        ...base,
        postprocess: { ...base.postprocess, mode: "letterbox" },
      } as unknown as AspectRatioProcessingMetadata),
    ).toBeNull();
    expect(
      resolveResizeTarget({
        ...base,
        postprocess: { ...base.postprocess, apply_to: "first_output" },
      } as unknown as AspectRatioProcessingMetadata),
    ).toBeNull();
    expect(
      resolveResizeTarget({
        ...base,
        postprocess: { ...base.postprocess, target_width: 0 },
      } as unknown as AspectRatioProcessingMetadata),
    ).toBeNull();
  });
});

describe("normalizeToSupportedProjectAspectRatio", () => {
  it("returns null for unparseable input", () => {
    expect(normalizeToSupportedProjectAspectRatio("")).toBeNull();
    expect(normalizeToSupportedProjectAspectRatio("portrait")).toBeNull();
    expect(normalizeToSupportedProjectAspectRatio("0:5")).toBeNull();
  });

  it("snaps wide ratios to 16:9", () => {
    expect(normalizeToSupportedProjectAspectRatio("1920:1080")).toBe("16:9");
    expect(normalizeToSupportedProjectAspectRatio("2:1")).toBe("16:9");
  });

  it("accepts the slash separator and snaps tall ratios", () => {
    expect(normalizeToSupportedProjectAspectRatio("9/16")).toBe("9:16");
    expect(normalizeToSupportedProjectAspectRatio("1/1")).toBe("1:1");
  });
});

describe("mime + container resolution", () => {
  it("passes through recognized image mime types and defaults the rest to png", () => {
    expect(resolveImageOutputMimeType(imageFile("a.jpg", "image/jpeg"))).toBe(
      "image/jpeg",
    );
    expect(resolveImageOutputMimeType(imageFile("a.webp", "image/webp"))).toBe(
      "image/webp",
    );
    expect(resolveImageOutputMimeType(imageFile("a.gif", "image/gif"))).toBe(
      "image/png",
    );
  });

  it("always resolves video output to an mp4 container", () => {
    const result = resolveVideoOutputContainer(imageFile("v.mp4", "video/mp4"));
    expect(result.mimeType).toBe("video/mp4");
    expect(result.format).toBeDefined();
  });
});

describe("canvas helpers", () => {
  it("isCanvas2DContext detects 2D-capable contexts", () => {
    expect(isCanvas2DContext(null)).toBe(false);
    expect(
      isCanvas2DContext({ foo: 1 } as unknown as CanvasRenderingContext2D),
    ).toBe(false);
    expect(
      isCanvas2DContext({
        drawImage: () => {},
        clearRect: () => {},
      } as unknown as CanvasRenderingContext2D),
    ).toBe(true);
  });

  it("createOutputCanvas uses an OffscreenCanvas when available", () => {
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    const canvas = createOutputCanvas(10, 20);
    expect(canvas).toBeInstanceOf(FakeOffscreen);
    expect(canvas.width).toBe(10);
    expect(canvas.height).toBe(20);
  });

  it("createOutputCanvas falls back to a DOM canvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const canvas = createOutputCanvas(30, 40);
    expect(canvas.width).toBe(30);
    expect(canvas.height).toBe(40);
  });

  it.each(["image/jpeg", "image/webp", "image/png"])(
    "converts offscreen canvases to %s",
    async (mimeType) => {
      const convertToBlob = vi.fn(async (options: ImageEncodeOptions) => {
        return new Blob(["converted"], { type: options.type });
      });
      class FakeOffscreen {
        convertToBlob = convertToBlob;
      }
      vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
      const canvas = new FakeOffscreen() as unknown as OffscreenCanvas;

      await expect(convertCanvasToBlob(canvas, mimeType)).resolves.toMatchObject({
        type: mimeType,
      });
      expect(convertToBlob).toHaveBeenCalledWith(
        mimeType === "image/png"
          ? { type: mimeType }
          : { type: mimeType, quality: 0.95 },
      );
    },
  );

  it("converts DOM canvases and rejects empty blobs", async () => {
    vi.stubGlobal("OffscreenCanvas", class FakeOffscreen {});
    const success = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) =>
        callback(new Blob(["ok"], { type })),
      ),
    } as unknown as HTMLCanvasElement;
    await expect(convertCanvasToBlob(success, "image/jpeg")).resolves.toBeInstanceOf(
      Blob,
    );
    expect(success.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.95,
    );

    const empty = {
      toBlob: vi.fn((callback: BlobCallback) => callback(null)),
    } as unknown as HTMLCanvasElement;
    await expect(convertCanvasToBlob(empty, "image/png")).rejects.toThrow(
      /empty blob/,
    );
  });
});

describe("probeVisualFileAspectRatio", () => {
  it("computes a reduced aspect ratio for images", async () => {
    stubBitmap(1920, 1080);
    expect(await probeVisualFileAspectRatio(imageFile())).toBe("16:9");
  });

  it("returns null for non-visual files", async () => {
    const audio = new File([new Uint8Array([0])], "a.mp3", { type: "audio/mpeg" });
    expect(await probeVisualFileAspectRatio(audio)).toBeNull();
  });

  it("probes video dimensions and always disposes the input", async () => {
    mediaMocks.primaryVideoTrack = { displayWidth: 1080, displayHeight: 1920 };
    const video = probeableVideoFile("v.mp4");
    expect(await probeVisualFileAspectRatio(video)).toBe("9:16");
    expect(mediaMocks.dispose).toHaveBeenCalledOnce();

    mediaMocks.primaryVideoTrack = null;
    expect(await probeVisualFileAspectRatio(video)).toBeNull();
    expect(mediaMocks.dispose).toHaveBeenCalledTimes(2);
  });

  it("returns null when the video blob cannot be probed", async () => {
    const video = new File(["video"], "v.mp4", { type: "video/mp4" });
    vi.spyOn(video, "slice").mockReturnValue(
      {} as Blob,
    );
    expect(await probeVisualFileAspectRatio(video)).toBeNull();
  });
});

describe("resizeImageToExactDimensions", () => {
  it("returns the original file when dimensions already match", async () => {
    stubBitmap(640, 480);
    const file = imageFile();
    const result = await resizeImageToExactDimensions(file, {
      width: 640,
      height: 480,
    });
    expect(result).toBe(file);
  });

  it("draws and converts a resized image", async () => {
    const { close } = stubBitmap(800, 600);
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    const convertToBlob = vi.fn(async () => new Blob(["image"], { type: "image/png" }));
    class FakeOffscreen {
      readonly width: number;
      readonly height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { clearRect, drawImage };
      }
      convertToBlob = convertToBlob;
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);

    const result = await resizeImageToExactDimensions(imageFile(), {
      width: 320,
      height: 240,
    });

    expect(result.name).toBe("frame.png");
    expect(clearRect).toHaveBeenCalledWith(0, 0, 320, 240);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects when no 2D resize context is available and closes the bitmap", async () => {
    const { close } = stubBitmap(800, 600);
    class FakeOffscreen {
      getContext() {
        return null;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    await expect(
      resizeImageToExactDimensions(imageFile(), { width: 10, height: 10 }),
    ).rejects.toThrow(/2D context/);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("cropImageToAspectRatio", () => {
  it("returns the original file when createImageBitmap is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const file = imageFile();
    expect(await cropImageToAspectRatio(file, "1:1")).toBe(file);
  });

  it("returns the original file when already at the target ratio", async () => {
    stubBitmap(512, 512);
    const file = imageFile();
    expect(await cropImageToAspectRatio(file, "1:1")).toBe(file);
  });

  it("crops toward the target ratio (reaching the canvas draw path)", async () => {
    // Source 1920x1080 cropped to 1:1 produces a non-equal target, so the
    // function advances past resolveAspectRatioCropTarget into canvas drawing.
    stubBitmap(1920, 1080);
    await expect(cropImageToAspectRatio(imageFile(), "1:1")).rejects.toThrow();
  });

  it("crops tall images and emits a converted file", async () => {
    const { close } = stubBitmap(600, 1200);
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    class FakeOffscreen {
      readonly width: number;
      readonly height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { clearRect, drawImage };
      }
      async convertToBlob() {
        return new Blob(["crop"], { type: "image/png" });
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);

    const result = await cropImageToAspectRatio(imageFile(), "16:9");
    expect(result).not.toBeNull();
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      expect.any(Number),
      600,
      expect.any(Number),
      0,
      0,
      600,
      expect.any(Number),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("video resize and crop", () => {
  const video = () => probeableVideoFile();

  it("returns an already-sized video and disposes input", async () => {
    mediaMocks.primaryVideoTrack = { displayWidth: 640, displayHeight: 480 };
    const file = video();
    await expect(
      resizeVideoToExactDimensions(file, { width: 640, height: 480 }),
    ).resolves.toBe(file);
    expect(mediaMocks.conversionInit).not.toHaveBeenCalled();
    expect(mediaMocks.dispose).toHaveBeenCalledOnce();
  });

  it("converts video resize output and rejects empty output", async () => {
    mediaMocks.primaryVideoTrack = { displayWidth: 1920, displayHeight: 1080 };
    const result = await resizeVideoToExactDimensions(video(), {
      width: 640,
      height: 480,
    });
    expect(result.name).toBe("source.mp4");
    expect(result.type).toBe("video/mp4");
    expect(mediaMocks.conversionInit).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          width: 640,
          height: 480,
          fit: "fill",
        }),
      }),
    );

    mediaMocks.outputBuffer = null;
    await expect(
      resizeVideoToExactDimensions(video(), { width: 320, height: 240 }),
    ).rejects.toThrow(/output buffer is empty/);
  });

  it("returns videos that cannot or do not need to be cropped", async () => {
    const noProbe = video();
    vi.spyOn(noProbe, "slice").mockReturnValue({} as Blob);
    await expect(cropVideoToAspectRatio(noProbe, "1:1")).resolves.toBe(noProbe);

    mediaMocks.primaryVideoTrack = null;
    const noTrack = video();
    await expect(cropVideoToAspectRatio(noTrack, "1:1")).resolves.toBe(noTrack);

    mediaMocks.primaryVideoTrack = { displayWidth: 640, displayHeight: 360 };
    const alreadyWide = video();
    await expect(
      cropVideoToAspectRatio(alreadyWide, "16:9"),
    ).resolves.toBe(alreadyWide);
  });

  it("crops videos to even dimensions and rejects empty output", async () => {
    mediaMocks.primaryVideoTrack = { displayWidth: 641, displayHeight: 481 };
    const result = await cropVideoToAspectRatio(video(), "1:1");
    expect(result.name).toBe("source.mp4");
    expect(mediaMocks.conversionInit).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          width: 480,
          height: 480,
          fit: "cover",
        }),
      }),
    );

    mediaMocks.outputBuffer = null;
    await expect(cropVideoToAspectRatio(video(), "1:1")).rejects.toThrow(
      /output buffer is empty/,
    );
  });
});

describe("maybeResizeVisualFile / maybeCropVisualFileToAspectRatio", () => {
  it("returns the file unchanged when no target is given", async () => {
    const file = imageFile();
    expect(await maybeResizeVisualFile(file, null)).toBe(file);
  });

  it("swallows resize errors and returns the original image file", async () => {
    stubBitmap(100, 100);
    const file = imageFile();
    const result = await maybeResizeVisualFile(file, { width: 50, height: 50 });
    expect(result).toBe(file);
  });

  it("returns audio files unchanged for resize and crop", async () => {
    const audio = new File([new Uint8Array([0])], "a.mp3", { type: "audio/mpeg" });
    expect(await maybeResizeVisualFile(audio, { width: 50, height: 50 })).toBe(
      audio,
    );
    expect(await maybeCropVisualFileToAspectRatio(audio, "1:1")).toBe(audio);
  });

  it("resizes and crops videos through their guarded wrappers", async () => {
    mediaMocks.primaryVideoTrack = { displayWidth: 1920, displayHeight: 1080 };
    const video = probeableVideoFile("v.mp4");
    await expect(
      maybeResizeVisualFile(video, { width: 640, height: 480 }),
    ).resolves.toBeInstanceOf(File);
    await expect(
      maybeCropVisualFileToAspectRatio(video, "1:1"),
    ).resolves.toBeInstanceOf(File);
  });

  it("swallows video resize and crop failures", async () => {
    mediaMocks.getPrimaryVideoTrack.mockRejectedValue(new Error("decode"));
    const video = probeableVideoFile("v.mp4");
    await expect(
      maybeResizeVisualFile(video, { width: 640, height: 480 }),
    ).resolves.toBe(video);
    await expect(
      maybeCropVisualFileToAspectRatio(video, "1:1"),
    ).resolves.toBe(video);
  });

  it("swallows crop errors and returns the original image file", async () => {
    stubBitmap(1920, 1080);
    const file = imageFile();
    expect(await maybeCropVisualFileToAspectRatio(file, "1:1")).toBe(file);
  });
});
