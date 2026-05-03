import { describe, it, expect } from "vitest";
import { mergeCachedPipelineOutputsIntoResponse } from "../generationPlan";

const baseEntry = (
  pipelineOutputs: Record<string, unknown>,
) =>
  ({
    key: "k",
    assets: {
      targetAspectRatio: "16:9",
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      pipelineInputs: {},
    },
    backendMedia: {
      cachedMediaInputs: {},
      pipelineOutputs,
    },
  }) as unknown as Parameters<
    typeof mergeCachedPipelineOutputsIntoResponse
  >[1];

describe("mergeCachedPipelineOutputsIntoResponse", () => {
  it("returns response unchanged when there is no cache", () => {
    const response = {
      pipeline_outputs: { mask_processing: { mask_crop_metadata: { mode: "full" } } },
    };
    expect(mergeCachedPipelineOutputsIntoResponse(response, null)).toBe(response);
  });

  it("keeps cached mask outputs when the response stage is empty", () => {
    // Reproduces the regression: cached preprocess paths leave the backend
    // pipeline runner's per-stage `setdefault({}, ...)` slot untouched, so
    // the response carries `mask_processing: {}` even though good cached
    // metadata exists.
    const cached = {
      mask_processing: {
        mask_crop_metadata: {
          mode: "cropped",
          crop_position: [10, 20],
          crop_size: [100, 100],
          container_size: [400, 300],
          scale: 0.25,
        },
        processed_mask_video: "BASE64",
      },
    };
    const response = {
      pipeline_outputs: {
        mask_processing: {} as Record<string, unknown>,
      },
    };

    const merged = mergeCachedPipelineOutputsIntoResponse(
      response,
      baseEntry(cached),
    );

    expect(merged.pipeline_outputs?.mask_processing).toEqual(
      cached.mask_processing,
    );
  });

  it("lets a non-empty response stage override the cached value", () => {
    const cached = { aspect_ratio: { aspect_ratio_processing: { stale: true } } };
    const response = {
      pipeline_outputs: {
        aspect_ratio: { aspect_ratio_processing: { fresh: true } },
      },
    };

    const merged = mergeCachedPipelineOutputsIntoResponse(
      response,
      baseEntry(cached),
    );

    expect(merged.pipeline_outputs?.aspect_ratio).toEqual({
      aspect_ratio_processing: { fresh: true },
    });
  });

  it("brings in cached stages absent from the response", () => {
    const cached = { mask_processing: { mask_crop_metadata: { mode: "full" } } };
    const response = {
      pipeline_outputs: {} as Record<string, Record<string, unknown>>,
    };

    const merged = mergeCachedPipelineOutputsIntoResponse(
      response,
      baseEntry(cached),
    );

    expect(merged.pipeline_outputs?.mask_processing).toEqual(
      cached.mask_processing,
    );
  });
});
