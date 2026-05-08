import { describe, expect, it } from "vitest";

import type { WorkflowInput } from "../../types";
import {
  type GenerationPreprocessCacheEntry,
  updateGenerationPreprocessCacheFromResponse,
} from "../generationPlan";
import type { GenerationPlan } from "../types";

function makeWorkflowInput(classType: string): WorkflowInput {
  return {
    nodeId: "94",
    classType,
    inputType: "video",
    param: "file",
    label: "Source video",
    currentValue: null,
    origin: "rule",
  };
}

function makePlan(classType: string): GenerationPlan {
  return {
    id: "plan-id",
    createdAt: 0,
    workflow: {
      workflow: null,
      graphData: null,
      workflowId: "workflow.json",
      workflowRules: null,
      workflowInputs: [makeWorkflowInput(classType)],
      submittedWorkflow: null,
      promptIsPreResolved: false,
    },
    preprocess: {
      slotValues: {
        "94:file": {
          type: "video",
          file: new File(["video"], "source.mp4", { type: "video/mp4" }),
        },
      },
      derivedMaskMappings: [],
      projectConfig: {
        fps: 24,
        aspectRatio: "16:9",
      },
      exactAspectRatio: false,
      targetResolution: 720,
      maskCropDilation: 0.1,
      maskCropMode: "crop",
    },
    submission: {
      widgetInputs: {},
      frontendStateWidgetValues: {},
      inputMetadata: {},
      derivedWidgetInputs: {},
      widgetModes: {},
      bypassNodeIds: [],
    },
    metadata: {
      generationMetadata: {
        source: "generated",
        workflowName: "Workflow",
        inputs: [],
      },
      workflowWarnings: [],
    },
    postprocess: {
      config: {
        mode: "none",
        panel_preview: "raw_outputs",
        on_failure: "fallback_raw",
      },
    },
  };
}

function makeCacheEntry(): GenerationPreprocessCacheEntry {
  return {
    key: "cache-key",
    assets: {
      targetAspectRatio: "16:9",
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      pipelineInputs: {},
    },
    backendMedia: null,
  };
}

describe("generationPlan cache media extraction", () => {
  it("does not cache VLO memory loader placeholders", () => {
    const entry = makeCacheEntry();
    const updated = updateGenerationPreprocessCacheFromResponse(
      entry,
      makePlan("VLOMemoryLoadVideo"),
      {
        comfyui_prompt: {
          "94": {
            class_type: "VLOMemoryLoadVideo",
            inputs: {
              file: "Loading...",
            },
          },
        },
      },
    );

    expect(updated.backendMedia).toBeNull();
  });

  it("still caches real VLO memory loader ids", () => {
    const entry = makeCacheEntry();
    const updated = updateGenerationPreprocessCacheFromResponse(
      entry,
      makePlan("VLOMemoryLoadVideo"),
      {
        comfyui_prompt: {
          "94": {
            class_type: "VLOMemoryLoadVideo",
            inputs: {
              file: "media-video-123",
            },
          },
        },
        pipeline_outputs: {
          mask_processing: {
            mask_crop_metadata: {
              mode: "full",
            },
          },
        },
      },
    );

    expect(updated.backendMedia).toEqual({
      cachedMediaInputs: {
        "94": {
          file: "media-video-123",
        },
      },
      pipelineOutputs: {
        mask_processing: {
          mask_crop_metadata: {
            mode: "full",
          },
        },
      },
    });
  });
});
