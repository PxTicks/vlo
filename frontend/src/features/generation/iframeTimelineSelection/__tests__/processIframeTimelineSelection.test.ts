// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../project";
import {
  createDefaultIframeTimelineSelectionSettings,
  processIframeTimelineSelection,
  type ProcessIframeTimelineSelectionDeps,
} from "../processIframeTimelineSelection";

const selection = {
  start: 96_000,
  end: 192_000,
  clips: [],
  tracks: [],
  fps: 24,
};

function createDeps(options: { transparent: boolean }) {
  const source = new File(["source"], "source.mp4", { type: "video/mp4" });
  const mask = new File(["mask"], "mask.mp4", { type: "video/mp4" });
  const thumbnail = new File(["thumb"], "thumb.png", { type: "image/png" });
  const maskThumbnail = new File(["mask-thumb"], "mask-thumb.png", {
    type: "image/png",
  });
  const renderWithMask = vi.fn().mockResolvedValue({
    video: source,
    mask,
    maskHasVisibleContent: options.transparent,
  });
  const applyMaskCrop = vi.fn().mockResolvedValue({
    video: new File(["cropped"], "cropped.mp4", { type: "video/mp4" }),
    masks: {
      video_binary: new File(["cropped-mask"], "cropped-mask.mp4", {
        type: "video/mp4",
      }),
    },
    metadata: {
      mode: "cropped",
      crop_position: [10, 20],
      crop_size: [640, 360],
      container_size: [1280, 720],
      scale: 0.5,
    },
    warnings: [],
  });
  const captureThumbnail = vi.fn().mockResolvedValue(thumbnail);
  const captureMaskThumbnail = vi.fn().mockResolvedValue(maskThumbnail);
  return {
    source,
    mask,
    maskThumbnail,
    renderWithMask,
    applyMaskCrop,
    captureThumbnail,
    captureMaskThumbnail,
    deps: {
      renderWithMask,
      applyMaskCrop,
      captureThumbnail,
      captureMaskThumbnail,
    } as ProcessIframeTimelineSelectionDeps,
  };
}

describe("processIframeTimelineSelection", () => {
  beforeEach(() => {
    useProjectStore.setState((state) => ({
      config: { ...state.config, aspectRatio: "16:9" },
    }));
  });

  it("renders video without returning or cropping an empty transparency mask", async () => {
    const mocks = createDeps({ transparent: false });
    const settings = createDefaultIframeTimelineSelectionSettings();

    const result = await processIframeTimelineSelection(selection, settings, {
      deps: mocks.deps,
    });

    expect(result.video).toBe(mocks.source);
    expect(result.mask).toBeNull();
    expect(result.maskThumbnail).toBeNull();
    expect(result.maskCropMetadata).toEqual({ mode: "full" });
    expect(mocks.applyMaskCrop).not.toHaveBeenCalled();
    expect(mocks.captureMaskThumbnail).not.toHaveBeenCalled();
  });

  it("uses strided dimensions and crops synchronized video and mask outputs", async () => {
    const mocks = createDeps({ transparent: true });
    const settings = createDefaultIframeTimelineSelectionSettings();
    settings.aspectRatio.enabled = true;
    settings.aspectRatio.targetAspectRatio = "16:9";
    settings.aspectRatio.targetResolution = 720;
    settings.aspectRatio.stride = 16;

    const result = await processIframeTimelineSelection(selection, settings, {
      deps: mocks.deps,
    });

    expect(mocks.renderWithMask).toHaveBeenCalledWith(
      selection,
      "binary",
      expect.objectContaining({
        sourceVideoTreatment: "preserve_transparency",
        outputWidth: 1280,
        outputHeight: 720,
      }),
    );
    expect(mocks.applyMaskCrop).toHaveBeenCalledWith(
      expect.objectContaining({
        video: mocks.source,
        masks: { video_binary: mocks.mask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      }),
    );
    expect(result.video.name).toBe("cropped.mp4");
    expect(result.mask?.name).toBe("cropped-mask.mp4");
    expect(mocks.captureMaskThumbnail).toHaveBeenCalledWith(result.mask);
    expect(result.maskThumbnail).toBe(mocks.maskThumbnail);
    expect(result.aspectRatioProcessing?.strided).toMatchObject({
      width: 1280,
      height: 720,
      stride: 16,
    });
    expect(result.maskCropMetadata.mode).toBe("cropped");
  });
});
