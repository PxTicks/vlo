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
      // Emitted in project (== logical) space: the crop runs on the project-dim
      // render, before the strided resize.
      mode: "cropped",
      crop_position: [100, 60],
      crop_size: [960, 540],
      container_size: [1920, 1080],
      scale: 0.5,
    },
    warnings: [],
  });
  const captureThumbnail = vi.fn().mockResolvedValue(thumbnail);
  const captureMaskThumbnail = vi.fn().mockResolvedValue(maskThumbnail);
  const resizeVideo = vi
    .fn()
    .mockImplementation(async (file: File) =>
      new File([`resized-${file.name}`], `resized-${file.name}`, {
        type: "video/mp4",
      }),
    );
  return {
    source,
    mask,
    maskThumbnail,
    renderWithMask,
    applyMaskCrop,
    resizeVideo,
    captureThumbnail,
    captureMaskThumbnail,
    deps: {
      renderWithMask,
      applyMaskCrop,
      resizeVideo,
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
    // Aspect-ratio processing is disabled here, so nothing is resized.
    expect(mocks.resizeVideo).not.toHaveBeenCalled();
  });

  it("crops at project dims, then resizes the cropped outputs to strided dims", async () => {
    const mocks = createDeps({ transparent: true });
    const settings = createDefaultIframeTimelineSelectionSettings();
    settings.aspectRatio.enabled = true;
    settings.aspectRatio.targetAspectRatio = "16:9";
    settings.aspectRatio.targetResolution = 720;
    settings.aspectRatio.stride = 16;

    const result = await processIframeTimelineSelection(selection, settings, {
      deps: mocks.deps,
    });

    // The render happens at the project's own dimensions (no strided override):
    // the crop must be taken from full-fidelity project pixels so the emitted
    // mask-crop metadata stays in project (== logical) space.
    const renderOptions = mocks.renderWithMask.mock.calls[0][2];
    expect(renderOptions).toMatchObject({
      sourceVideoTreatment: "preserve_transparency",
    });
    expect(renderOptions).not.toHaveProperty("outputWidth");
    expect(renderOptions).not.toHaveProperty("outputHeight");

    expect(mocks.applyMaskCrop).toHaveBeenCalledWith(
      expect.objectContaining({
        video: mocks.source,
        masks: { video_binary: mocks.mask },
        targetAspectRatio: "16:9",
        cropMode: "crop",
        cropDilation: 0.1,
      }),
    );

    // The stride guarantee is enforced by resizing the cropped video and mask
    // to the strided dimensions after cropping.
    expect(mocks.resizeVideo).toHaveBeenCalledTimes(2);
    expect(mocks.resizeVideo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "cropped.mp4" }),
      1280,
      720,
      expect.any(Object),
    );
    expect(mocks.resizeVideo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "cropped-mask.mp4" }),
      1280,
      720,
      expect.any(Object),
    );
    expect(result.video.name).toBe("resized-cropped.mp4");
    expect(result.mask?.name).toBe("resized-cropped-mask.mp4");

    // The mask thumbnail is captured from the final (resized) mask.
    expect(mocks.captureMaskThumbnail).toHaveBeenCalledWith(result.mask);
    expect(result.maskThumbnail).toBe(mocks.maskThumbnail);
    expect(result.aspectRatioProcessing?.strided).toMatchObject({
      width: 1280,
      height: 720,
      stride: 16,
    });
    // Crop metadata stays in project space (container == render/logical dims),
    // not the strided render size — this is what keeps timeline placement right.
    expect(result.maskCropMetadata).toMatchObject({
      mode: "cropped",
      container_size: [1920, 1080],
    });
  });
});
