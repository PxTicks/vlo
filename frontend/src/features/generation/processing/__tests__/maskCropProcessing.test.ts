import { describe, expect, it, vi } from "vitest";
import { computeMaskCrop, type MaskBounds } from "../maskCropMath";
import {
  applyMaskCropProcessing,
  isAudioTimingMaskRenderKey,
  type MaskCropProcessingDeps,
} from "../maskCropProcessing";
import type { MaskVideoBoundsAnalysis } from "../maskVideoAnalysis";

function makeFile(name: string): File {
  return new File(["stub"], name, { type: "video/mp4" });
}

function makeAnalysis(
  rawBounds: MaskBounds | null,
  containerWidth = 1920,
  containerHeight = 1080,
  targetAr = 16 / 9,
  dilation = 0.1,
): MaskVideoBoundsAnalysis {
  return {
    rawBounds,
    cropRegion: computeMaskCrop(
      rawBounds,
      containerWidth,
      containerHeight,
      targetAr,
      dilation,
    ),
    containerWidth,
    containerHeight,
  };
}

function makeDeps(
  analyses: Record<string, MaskVideoBoundsAnalysis>,
): MaskCropProcessingDeps & {
  analyzeMaskVideoBounds: ReturnType<typeof vi.fn>;
  cropVideoToRect: ReturnType<typeof vi.fn>;
} {
  const analyzeMaskVideoBounds = vi.fn(async (maskFile: File) => {
    const analysis = analyses[maskFile.name];
    if (!analysis) throw new Error(`No stub analysis for ${maskFile.name}`);
    return analysis;
  });
  const cropVideoToRect = vi.fn(async (file: File, region: MaskBounds) =>
    makeFile(`cropped-${region.join("_")}-${file.name}`),
  );
  return { analyzeMaskVideoBounds, cropVideoToRect };
}

describe("isAudioTimingMaskRenderKey", () => {
  it("identifies audio timing keys", () => {
    expect(isAudioTimingMaskRenderKey("audio_timing_binary_25")).toBe(true);
    expect(isAudioTimingMaskRenderKey("video_binary")).toBe(false);
    expect(isAudioTimingMaskRenderKey("video_soft")).toBe(false);
  });
});

describe("applyMaskCropProcessing", () => {
  const video = makeFile("video.mp4");
  const binaryMask = makeFile("mask-binary.mp4");
  const audioMask = makeFile("mask-audio.mp4");

  it("passes through with full metadata when crop mode is full", async () => {
    const deps = makeDeps({});
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask },
        targetAspectRatio: "16:9",
        cropMode: "full",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(result.video).toBe(video);
    expect(result.masks.video_binary).toBe(binaryMask);
    expect(deps.analyzeMaskVideoBounds).not.toHaveBeenCalled();
  });

  it("passes through when dilation is missing or negative", async () => {
    const deps = makeDeps({});
    for (const cropDilation of [undefined, -0.1, Number.NaN]) {
      const result = await applyMaskCropProcessing(
        {
          video,
          masks: { video_binary: binaryMask },
          targetAspectRatio: "16:9",
          cropMode: "crop",
          cropDilation,
        },
        deps,
      );
      expect(result.metadata).toEqual({ mode: "full" });
    }
    expect(deps.analyzeMaskVideoBounds).not.toHaveBeenCalled();
  });

  it("passes through without a parseable target aspect ratio", async () => {
    const deps = makeDeps({});
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask },
        targetAspectRatio: null,
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(deps.analyzeMaskVideoBounds).not.toHaveBeenCalled();
  });

  it("passes through when only audio-timing masks are present", async () => {
    const deps = makeDeps({});
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { audio_timing_binary_25: audioMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(result.masks.audio_timing_binary_25).toBe(audioMask);
    expect(deps.analyzeMaskVideoBounds).not.toHaveBeenCalled();
  });

  it("returns full metadata for an empty mask", async () => {
    const deps = makeDeps({ [binaryMask.name]: makeAnalysis(null) });
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(deps.cropVideoToRect).not.toHaveBeenCalled();
  });

  it("crops video and visual mask, leaving audio-timing masks untouched", async () => {
    const deps = makeDeps({
      [binaryMask.name]: makeAnalysis([400, 300, 600, 500]),
    });
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: {
          video_binary: binaryMask,
          audio_timing_binary_25: audioMask,
        },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );

    const expectedRegion = computeMaskCrop(
      [400, 300, 600, 500],
      1920,
      1080,
      16 / 9,
      0.1,
    );
    expect(expectedRegion).not.toBeNull();
    expect(deps.cropVideoToRect).toHaveBeenCalledTimes(2);
    expect(deps.cropVideoToRect).toHaveBeenCalledWith(
      binaryMask,
      expectedRegion,
      expect.objectContaining({ bitrate: expect.any(Number) }),
    );
    expect(deps.cropVideoToRect).toHaveBeenCalledWith(
      video,
      expectedRegion,
      expect.not.objectContaining({ bitrate: expect.anything() }),
    );

    expect(result.masks.audio_timing_binary_25).toBe(audioMask);
    expect(result.video.name).toContain("cropped-");
    expect(result.masks.video_binary?.name).toContain("cropped-");

    const [x1, y1, x2, y2] = expectedRegion ?? [0, 0, 0, 0];
    expect(result.metadata).toEqual({
      mode: "cropped",
      crop_position: [x1, y1],
      crop_size: [x2 - x1, y2 - y1],
      container_size: [1920, 1080],
      scale: expect.any(Number),
    });
    if (result.metadata.mode === "cropped") {
      const expectedScale =
        Math.hypot(x2 - x1, y2 - y1) / Math.hypot(1920, 1080);
      expect(result.metadata.scale).toBeCloseTo(expectedScale, 6);
    }
  });

  it("crops all visual masks with one union region", async () => {
    const softMask = makeFile("mask-soft.mp4");
    const deps = makeDeps({
      [binaryMask.name]: makeAnalysis([400, 300, 600, 500]),
      [softMask.name]: makeAnalysis([500, 400, 800, 600]),
    });
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask, video_soft: softMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );

    const unionRegion = computeMaskCrop(
      [400, 300, 800, 600],
      1920,
      1080,
      16 / 9,
      0.1,
    );
    expect(result.metadata.mode).toBe("cropped");
    for (const call of deps.cropVideoToRect.mock.calls) {
      expect(call[1]).toEqual(unionRegion);
    }
  });

  it("reverts to full mode with a warning when analysis fails", async () => {
    const deps = makeDeps({});
    deps.analyzeMaskVideoBounds.mockRejectedValueOnce(new Error("decode failed"));
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(result.video).toBe(video);
    expect(result.masks.video_binary).toBe(binaryMask);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "mask_crop_processing_failed",
    ]);
  });

  it("reverts to full mode when cropping fails midway", async () => {
    const deps = makeDeps({
      [binaryMask.name]: makeAnalysis([400, 300, 600, 500]),
    });
    deps.cropVideoToRect.mockRejectedValueOnce(new Error("encode failed"));
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(result.video).toBe(video);
    expect(result.masks.video_binary).toBe(binaryMask);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "mask_crop_processing_failed",
    ]);
  });

  it("skips cropping when visual masks disagree on container size", async () => {
    const softMask = makeFile("mask-soft.mp4");
    const deps = makeDeps({
      [binaryMask.name]: makeAnalysis([400, 300, 600, 500], 1920, 1080),
      [softMask.name]: makeAnalysis([400, 300, 600, 500], 1280, 720),
    });
    const result = await applyMaskCropProcessing(
      {
        video,
        masks: { video_binary: binaryMask, video_soft: softMask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      },
      deps,
    );
    expect(result.metadata).toEqual({ mode: "full" });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "mask_crop_container_mismatch",
    ]);
    expect(deps.cropVideoToRect).not.toHaveBeenCalled();
  });
});
