import { describe, expect, it } from "vitest";

import {
  buildWorkflowReplayPipelineInputs,
  createDefaultWorkflowRules,
  getWorkflowReplayPipelineValue,
  getMaskCropDilationDefault,
  getMaskCropModeDefault,
  getSupportedWorkflowResolutions,
  getWorkflowPostprocessingConfig,
} from "../workflowRules";


describe("workflowRules pipeline helpers", () => {
  it("reads aspect-ratio resolutions from the v3 pipeline", () => {
    const rules = createDefaultWorkflowRules({
      pipeline: [
        {
          id: "aspect_ratio",
          kind: "aspect_ratio",
          config: {
            resolutions: [480, 720, 1080],
          },
          targets: [
            {
              width: { node_id: "1", param: "width" },
              height: { node_id: "1", param: "height" },
            },
          ],
        },
      ],
    });

    expect(getSupportedWorkflowResolutions(rules)).toEqual([480, 720, 1080]);
  });

  it("reads mask defaults from mask-processing controls", () => {
    const rules = createDefaultWorkflowRules({
      pipeline: [
        {
          id: "mask_processing",
          kind: "mask_processing",
          controls: [
            { key: "crop_mode", default: "full" },
            { key: "crop_dilation", default: 0.2 },
          ],
        },
      ],
    });

    expect(getMaskCropModeDefault(rules)).toBe("full");
    expect(getMaskCropDilationDefault(rules)).toBe(0.2);
  });

  it("reads output-assembly config from the v3 pipeline", () => {
    const rules = createDefaultWorkflowRules({
      pipeline: [
        {
          id: "output_assembly",
          kind: "output_assembly",
          config: {
            mode: "stitch_frames_with_audio",
            panel_preview: "replace_outputs",
            on_failure: "show_error",
            stitch_fps: 24,
          },
        },
      ],
    });

    expect(getWorkflowPostprocessingConfig(rules)).toEqual({
      mode: "stitch_frames_with_audio",
      panel_preview: "replace_outputs",
      on_failure: "show_error",
      stitch_fps: 24,
    });
  });

  it("builds and reads replay pipeline inputs from stage ids", () => {
    const rules = createDefaultWorkflowRules({
      pipeline: [
        {
          id: "custom_aspect",
          kind: "aspect_ratio",
          controls: [{ key: "target_resolution", value_type: "int" }],
          targets: [],
        },
        {
          id: "custom_mask",
          kind: "mask_processing",
          controls: [
            { key: "crop_mode", value_type: "enum" },
            { key: "crop_dilation", value_type: "float" },
          ],
          targets: [],
        },
      ],
    });

    const replayPipelineInputs = buildWorkflowReplayPipelineInputs(rules, {
      targetResolution: 720,
      maskCropMode: "crop",
      maskCropDilation: 0.2,
    });

    expect(replayPipelineInputs).toEqual({
      custom_aspect: {
        target_resolution: 720,
      },
      custom_mask: {
        crop_mode: "crop",
        crop_dilation: 0.2,
      },
    });
    expect(
      getWorkflowReplayPipelineValue(rules, replayPipelineInputs, {
        stageKind: "aspect_ratio",
        key: "target_resolution",
      }),
    ).toBe(720);
  });
});
