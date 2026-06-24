import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutputCanvas,
  cropImageToAspectRatio,
  isCanvas2DContext,
  maybeCropVisualFileToAspectRatio,
  maybeResizeVisualFile,
  normalizeToSupportedProjectAspectRatio,
  probeVisualFileAspectRatio,
  resizeImageToExactDimensions,
  resolveImageOutputMimeType,
  resolveResizeTarget,
  resolveVideoOutputContainer,
} from "../media";
import type { AspectRatioProcessingMetadata } from "../../../types";

function imageFile(name = "frame.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
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

  it("swallows crop errors and returns the original image file", async () => {
    stubBitmap(1920, 1080);
    const file = imageFile();
    expect(await maybeCropVisualFileToAspectRatio(file, "1:1")).toBe(file);
  });
});
