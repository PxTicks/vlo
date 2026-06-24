import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AspectRatioProcessingMetadata } from "../../../types";
import { aspectRatioResize } from "../aspectRatioResize";
import type { FrontendPostprocessContext } from "../../types";

const { mockMaybeResizeVisualFile } = vi.hoisted(() => ({
  mockMaybeResizeVisualFile: vi.fn(),
}));

vi.mock("../../utils/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/media")>();
  return {
    ...actual,
    maybeResizeVisualFile: mockMaybeResizeVisualFile,
  };
});

function makeAspectRatioProcessingMetadata(): AspectRatioProcessingMetadata {
  return {
    enabled: true,
    requested: {
      aspect_ratio: "16:9",
      resolution: 720,
      width: 1280,
      height: 720,
    },
    strided: {
      width: 1280,
      height: 720,
      aspect_ratio: 16 / 9,
      distortion: 0,
      error: 0,
      stride: 64,
      search_steps: 1,
    },
    applied_nodes: [],
    postprocess: {
      enabled: true,
      mode: "stretch_exact",
      apply_to: "all_visual_outputs",
      target_width: 1280,
      target_height: 720,
    },
  };
}

function makeContext(preparedMaskFile: File | null): FrontendPostprocessContext {
  return {
    outputs: [],
    postprocessingConfig: {
      mode: "none",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    },
    aspectRatioProcessing: makeAspectRatioProcessingMetadata(),
    generationMetadata: {
      source: "generated",
      workflowName: "Mask Workflow",
      inputs: [],
    },
    autoFamilyRequestKey: null,
    previewFrameFiles: [],
    preparedMaskFile,
    fetchedFiles: [],
    frameFiles: [],
    audioFiles: [],
    videoFiles: [],
    packagedVideo: null,
    packagedVideoCompatibility: null,
    stitchFailure: null,
    stitchMessage: null,
    importedAssetIds: [],
    postprocessedPreview: null,
    postprocessError: null,
  };
}

describe("aspectRatioResize", () => {
  beforeEach(() => {
    mockMaybeResizeVisualFile.mockReset();
  });

  it("resizes a prepared mask file to the exact output dimensions", async () => {
    const preparedMaskFile = new File(["mask"], "mask.mp4", {
      type: "video/mp4",
    });
    const resizedMaskFile = new File(["resized-mask"], "mask.mp4", {
      type: "video/mp4",
    });
    const ctx = makeContext(preparedMaskFile);

    mockMaybeResizeVisualFile.mockResolvedValue(resizedMaskFile);

    expect(aspectRatioResize.isActive(ctx)).toBe(true);

    await aspectRatioResize.execute(ctx);

    expect(mockMaybeResizeVisualFile).toHaveBeenCalledTimes(1);
    expect(mockMaybeResizeVisualFile).toHaveBeenCalledWith(preparedMaskFile, {
      width: 1280,
      height: 720,
    });
    expect(ctx.preparedMaskFile).toBe(resizedMaskFile);
  });

  it("is inactive and performs no work without a resize target", async () => {
    const ctx = {
      ...makeContext(null),
      aspectRatioProcessing: null,
    };

    expect(aspectRatioResize.isActive(ctx)).toBe(false);
    await aspectRatioResize.execute(ctx);
    expect(mockMaybeResizeVisualFile).not.toHaveBeenCalled();
  });

  it("resizes fetched and packaged visuals then rebuilds media buckets", async () => {
    const image = new File(["image"], "frame.png", { type: "image/png" });
    const audio = new File(["audio"], "sound.wav", { type: "audio/wav" });
    const video = new File(["video"], "movie.mp4", { type: "video/mp4" });
    const packaged = new File(["packaged"], "packaged.mp4", {
      type: "video/mp4",
    });
    const resizedImage = new File(["resized"], "frame.png", {
      type: "image/png",
    });
    const resizedVideo = new File(["resized"], "movie.mp4", {
      type: "video/mp4",
    });
    const resizedPackaged = new File(["resized"], "packaged.mp4", {
      type: "video/mp4",
    });
    const ctx = makeContext(null);
    ctx.fetchedFiles = [
      { file: image, output: { filename: "frame.png", subfolder: "", type: "output", viewUrl: "/frame.png" } },
      { file: audio, output: { filename: "sound.wav", subfolder: "", type: "output", viewUrl: "/sound.wav" } },
      { file: video, output: { filename: "movie.mp4", subfolder: "", type: "output", viewUrl: "/movie.mp4" } },
    ];
    ctx.packagedVideo = packaged;
    mockMaybeResizeVisualFile
      .mockResolvedValueOnce(resizedImage)
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(resizedVideo)
      .mockResolvedValueOnce(resizedPackaged);

    await aspectRatioResize.execute(ctx);

    expect(ctx.frameFiles).toEqual([resizedImage]);
    expect(ctx.audioFiles).toEqual([audio]);
    expect(ctx.videoFiles).toEqual([resizedVideo]);
    expect(ctx.packagedVideo).toBe(resizedPackaged);
    expect(mockMaybeResizeVisualFile).toHaveBeenCalledTimes(4);
  });
});
