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
    previewFrameFiles: [],
    preparedMaskFile,
    fetchedFiles: [],
    frameFiles: [],
    audioFiles: [],
    videoFiles: [],
    packagedVideo: null,
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
    const preparedMaskFile = new File(["mask"], "mask.webm", {
      type: "video/webm",
    });
    const resizedMaskFile = new File(["resized-mask"], "mask.webm", {
      type: "video/webm",
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
});
