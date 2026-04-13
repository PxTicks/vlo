import { describe, expect, it } from "vitest";
import {
  buildGeneratedCreationMetadata,
  extractReplayPanelState,
  parseReplayWorkflowInputs,
} from "../metadata";
import { createDefaultWorkflowRules } from "../../services/workflowRules";
import type { WorkflowInput } from "../../types";

describe("generation metadata replay helpers", () => {
  it("captures replay-oriented frontend state alongside legacy generation metadata", () => {
    const workflowInputs: WorkflowInput[] = [
      {
        id: "6:text",
        nodeId: "6",
        classType: "CLIPTextEncode",
        inputType: "text",
        param: "text",
        label: "Prompt",
        description: "Main prompt",
        currentValue: "old prompt",
        origin: "rule",
      },
      {
        id: "145:image",
        nodeId: "145",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start Frame",
        currentValue: null,
        origin: "rule",
        dispatch: {
          kind: "node",
          selectionConfig: {
            exportFps: 12,
            frameStep: 2,
          },
        },
      },
    ];

    const metadata = buildGeneratedCreationMetadata({
      workflowName: "Workflow",
      workflowSourceId: "wan2_2_flf2v.json",
      workflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            controls: [{ key: "target_resolution", value_type: "int" }],
            targets: [],
          },
          {
            id: "mask_processing",
            kind: "mask_processing",
            controls: [
              { key: "crop_mode", value_type: "enum" },
              { key: "crop_dilation", value_type: "float" },
            ],
            targets: [],
          },
        ],
      }),
      workflowInputs,
      mediaInputs: {},
      slotValues: {
        "6:text": {
          type: "text",
          value: "updated prompt",
        },
      },
      targetResolution: 720,
      exactAspectRatio: true,
      maskCropMode: "full",
      maskCropDilation: 0.2,
      widgetInputs: {
        widget_145_strength_model: "0.5",
      },
      widgetModes: {
        widget_mode_145_seed: "randomize",
      },
      derivedWidgetInputs: {
        derived_widget_dual_sampler_denoise: "0.4",
      },
    });

    expect(metadata).toEqual({
      source: "generated",
      workflowName: "Workflow",
      workflowSourceId: "wan2_2_flf2v.json",
      inputs: [],
      targetResolution: 720,
      replayState: {
        version: 2,
        workflowSourceId: "wan2_2_flf2v.json",
        workflowInputs: [
          {
            id: "6:text",
            nodeId: "6",
            classType: "CLIPTextEncode",
            inputType: "text",
            param: "text",
            label: "Prompt",
            description: "Main prompt",
            origin: "rule",
          },
          {
            id: "145:image",
            nodeId: "145",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Start Frame",
            origin: "rule",
            dispatch: {
              kind: "node",
              selectionConfig: {
                exportFps: 12,
                frameStep: 2,
              },
            },
          },
        ],
        textValues: {
          "6:text": "updated prompt",
        },
        widgetValues: {
          widget_145_strength_model: "0.5",
        },
        widgetModes: {
          widget_mode_145_seed: "randomize",
        },
        derivedWidgetValues: {
          derived_widget_dual_sampler_denoise: "0.4",
        },
        exactAspectRatio: true,
        pipelineInputs: {
          aspect_ratio: {
            target_resolution: 720,
          },
          mask_processing: {
            crop_mode: "full",
          },
        },
        maskCropMode: "full",
        maskCropDilation: 0.2,
      },
    });
  });

  it("restores replay workflow inputs and panel state from saved metadata", () => {
    const replayState = {
      version: 1 as const,
      workflowSourceId: "wan2_2_flf2v.json",
      workflowInputs: [
        {
          id: "145:image",
          nodeId: "145",
          classType: "LoadImage",
          inputType: "image" as const,
          param: "image",
          label: "Start Frame",
          origin: "rule" as const,
        },
      ],
      textValues: {
        "6:text": "updated prompt",
      },
      widgetValues: {
        widget_145_strength_model: "0.5",
      },
      widgetModes: {
        widget_mode_145_seed: "randomize" as const,
      },
      derivedWidgetValues: {
        derived_widget_dual_sampler_denoise: "0.4",
      },
      exactAspectRatio: true,
      maskCropMode: "full" as const,
      maskCropDilation: 0.2,
    };

    expect(parseReplayWorkflowInputs(replayState)).toEqual([
      {
        id: "145:image",
        nodeId: "145",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start Frame",
        description: null,
        currentValue: null,
        origin: "rule",
      },
    ]);

    expect(
      extractReplayPanelState({
        source: "generated",
        workflowName: "Workflow",
        inputs: [],
        replayState,
      }),
    ).toEqual({
      textValues: {
        "6:text": "updated prompt",
      },
      widgetValues: {
        widget_145_strength_model: "0.5",
      },
      widgetModes: {
        widget_mode_145_seed: "randomize",
      },
      derivedWidgetValues: {
        derived_widget_dual_sampler_denoise: "0.4",
      },
    });
  });

  it("persists frame captures through timeline-selection metadata", () => {
    const timelineSelection = {
      start: 120,
      clips: [],
      fps: 24,
    };
    const workflowInputs: WorkflowInput[] = [
      {
        id: "145:image",
        nodeId: "145",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Frame Input",
        currentValue: null,
        origin: "rule",
      },
    ];

    const metadata = buildGeneratedCreationMetadata({
      workflowName: "Workflow",
      workflowSourceId: "workflow.json",
      workflowRules: null,
      workflowInputs,
      mediaInputs: {
        "145:image": {
          kind: "frame",
          file: new File(["frame"], "frame.png", { type: "image/png" }),
          previewUrl: "blob:frame",
          timelineSelection,
        },
      },
      slotValues: {},
      targetResolution: 720,
      exactAspectRatio: false,
      maskCropMode: "crop",
      maskCropDilation: 0.1,
      widgetInputs: {},
      widgetModes: {},
      derivedWidgetInputs: {},
    });

    expect(metadata.inputs).toEqual([
      {
        nodeId: "145",
        kind: "timelineSelection",
        timelineSelection,
      },
    ]);
  });

  it("snapshots shared clip selections independently for frame and audio inputs", () => {
    const sharedClip = {
      id: "clip-1",
      type: "video" as const,
      name: "Clip",
      assetId: "asset-1",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-1",
      start: 0,
    };
    const frameSelection = {
      start: 10,
      clips: [sharedClip],
      fps: 24,
    };
    const audioSelection = {
      start: 0,
      end: 100,
      clips: [sharedClip],
      fps: 24,
    };
    const workflowInputs: WorkflowInput[] = [
      {
        id: "45:image",
        nodeId: "45",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Start Frame",
        currentValue: null,
        origin: "rule",
      },
      {
        id: "232:audio",
        nodeId: "232",
        classType: "LoadAudio",
        inputType: "audio",
        param: "audio",
        label: "Custom Audio",
        currentValue: null,
        origin: "rule",
      },
    ];

    const metadata = buildGeneratedCreationMetadata({
      workflowName: "Workflow",
      workflowSourceId: "video_ltx2_3_flf2v.json",
      workflowRules: null,
      workflowInputs,
      mediaInputs: {
        "45:image": {
          kind: "frame",
          file: new File(["frame"], "frame.png", { type: "image/png" }),
          previewUrl: "blob:frame",
          timelineSelection: frameSelection,
        },
        "232:audio": {
          kind: "timelineSelection",
          mediaType: "audio",
          timelineSelection: audioSelection,
          thumbnailFile: new File(["thumb"], "thumb.txt", {
            type: "text/plain",
          }),
          thumbnailUrl: "blob:thumb",
          isExtracting: false,
          extractionRequestId: 0,
          preparedAudioFile: null,
          extractionError: null,
        },
      },
      slotValues: {},
      targetResolution: 720,
      exactAspectRatio: false,
      maskCropMode: "crop",
      maskCropDilation: 0.1,
      widgetInputs: {},
      widgetModes: {},
      derivedWidgetInputs: {},
    });

    expect(metadata.inputs).toHaveLength(2);
    expect(metadata.inputs[0]).toMatchObject({
      nodeId: "45",
      kind: "timelineSelection",
      timelineSelection: frameSelection,
    });
    expect(metadata.inputs[1]).toMatchObject({
      nodeId: "232",
      kind: "timelineSelection",
      timelineSelection: audioSelection,
    });

    if (
      metadata.inputs[0]?.kind !== "timelineSelection" ||
      metadata.inputs[1]?.kind !== "timelineSelection"
    ) {
      throw new Error("Expected timeline selection metadata inputs");
    }

    expect(metadata.inputs[0].timelineSelection).not.toBe(frameSelection);
    expect(metadata.inputs[1].timelineSelection).not.toBe(audioSelection);
    expect(metadata.inputs[0].timelineSelection.clips[0]).not.toBe(sharedClip);
    expect(metadata.inputs[1].timelineSelection.clips[0]).not.toBe(sharedClip);
  });
});
