import { beforeEach, describe, expect, it, vi } from "vitest";

const frontendPreprocessMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/pipeline", () => ({
  frontendPreprocess: frontendPreprocessMock,
}));

import type { WorkflowInput } from "../../types";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import {
  buildGenerationPreprocessCacheEntry,
  buildGenerationPreprocessCacheKey,
  buildSubmittedGeneration,
  createGenerationPlan,
  getSaveImageWebsocketNodeIds,
  mergeCachedPipelineOutputsIntoResponse,
  prepareGenerationPlan,
  type GenerationPreprocessCacheEntry,
  updateGenerationPreprocessCacheFromResponse,
} from "../generationPlan";
import type { GenerationPlan, SlotValue } from "../types";

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
      workflow: {
        "94": {
          class_type: classType,
          inputs: {
            file: "",
            disable_in_memory: false,
          },
        },
      },
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
      aspectRatioSelection: "auto",
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
      activateNodeIds: [],
      contributedEffects: [],
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
    effects: null,
  };
}

function makeBatchPlan(): GenerationPlan {
  const plan = makePlan("vloMemoryLoadVideoBatch");
  const node = plan.workflow.workflow?.["94"] as {
    inputs: Record<string, unknown>;
  };
  node.inputs = {
    files: { __value__: [] },
    disable_in_memory: false,
  };
  plan.workflow.workflowInputs = [
    {
      ...makeWorkflowInput("vloMemoryLoadVideoBatch"),
      param: "files",
    },
  ];
  plan.preprocess.slotValues = {
    "94:files": plan.preprocess.slotValues["94:file"],
  };
  return plan;
}

function makeCacheEntry(): GenerationPreprocessCacheEntry {
  return {
    key: "cache-key",
    preparedMediaGroupId: "group-1",
    preparedMediaHeld: false,
    assets: {
      targetAspectRatio: "16:9",
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      batchInputOptions: {},
      pipelineInputs: {},
    },
    backendMedia: null,
  };
}

describe("generationPlan cache media extraction", () => {
  beforeEach(() => {
    frontendPreprocessMock.mockReset();
  });

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

  it("keeps fallback uploads for active memory loaders on cached reruns", async () => {
    const plan = makePlan("VLOMemoryLoadVideo");
    const cacheEntry: GenerationPreprocessCacheEntry = {
      ...makeCacheEntry(),
      key: buildGenerationPreprocessCacheKey(plan) ?? "cache-key",
      assets: {
        targetAspectRatio: "16:9",
        imageInputs: {},
        audioInputs: {},
        videoInputs: {
          "94": (
            plan.preprocess.slotValues["94:file"] as Extract<
              SlotValue,
              { type: "video" }
            >
          ).file,
        },
        batchInputOptions: {},
        pipelineInputs: {},
      },
      backendMedia: {
        cachedMediaInputs: {
          "94": {
            file: "media-video-123",
          },
        },
        pipelineOutputs: {},
      },
    };

    const prepared = await prepareGenerationPlan(plan, {
      clientId: "client-id",
      cacheEntry,
    });

    expect(prepared.request.cachedMediaInputs).toEqual({
      "94": {
        file: "media-video-123",
      },
    });
    expect(prepared.request.videoInputs).toEqual({
      "94": (
        plan.preprocess.slotValues["94:file"] as Extract<
          SlotValue,
          { type: "video" }
        >
      ).file,
    });
  });

  it("changes the preprocess cache key when a memory loader toggles out of in-memory mode", () => {
    const memoryPlan = makePlan("VLOMemoryLoadVideo");
    const filePlan: GenerationPlan = {
      ...memoryPlan,
      submission: {
        ...memoryPlan.submission,
        widgetInputs: {
          widget_94_disable_in_memory: "true",
        },
      },
    };

    expect(buildGenerationPreprocessCacheKey(memoryPlan)).not.toBe(
      buildGenerationPreprocessCacheKey(filePlan),
    );
  });

  it("changes the preprocess cache key when a batch memory loader changes mode", () => {
    const memoryPlan = makeBatchPlan();
    const filePlan: GenerationPlan = {
      ...memoryPlan,
      submission: {
        ...memoryPlan.submission,
        widgetInputs: {
          widget_94_disable_in_memory: "true",
        },
      },
    };

    expect(buildGenerationPreprocessCacheKey(memoryPlan)).not.toBe(
      buildGenerationPreprocessCacheKey(filePlan),
    );
  });

  it.each([
    { __value__: [] },
    { __value__: [""] },
    { __value__: ["Loading..."] },
  ])("does not cache empty or placeholder batch values", (files) => {
    const entry = makeCacheEntry();
    const updated = updateGenerationPreprocessCacheFromResponse(
      entry,
      makeBatchPlan(),
      {
        comfyui_prompt: {
          "94": {
            class_type: "vloMemoryLoadVideoBatch",
            inputs: { files },
          },
        },
      },
    );

    expect(updated.backendMedia).toBeNull();
  });

  it("caches a non-empty wrapped batch value", () => {
    const entry = makeCacheEntry();
    const updated = updateGenerationPreprocessCacheFromResponse(
      entry,
      makeBatchPlan(),
      {
        comfyui_prompt: {
          "94": {
            class_type: "vloMemoryLoadVideoBatch",
            inputs: { files: { __value__: ["media-video-123"] } },
          },
        },
      },
    );

    expect(updated.backendMedia?.cachedMediaInputs).toEqual({
      "94": { files: { __value__: ["media-video-123"] } },
    });
  });

  it("treats lowercase vlo memory loaders as in-memory loaders too", () => {
    const entry = makeCacheEntry();
    const updated = updateGenerationPreprocessCacheFromResponse(
      entry,
      makePlan("vloMemoryLoadVideo"),
      {
        comfyui_prompt: {
          "94": {
            class_type: "vloMemoryLoadVideo",
            inputs: {
              file: "Loading...",
            },
          },
        },
      },
    );

    expect(updated.backendMedia).toBeNull();
  });

  it("stores backend-applied randomized widget values in replay metadata", () => {
    const plan = makePlan("KSampler");
    plan.metadata.generationMetadata = {
      source: "generated",
      workflowName: "Workflow",
      inputs: [],
      replayState: {
        version: 2,
        workflowInputs: [],
        widgetValues: {
          widget_94_seed: "11",
          widget_94_steps: "30",
        },
        widgetModes: {
          widget_mode_94_seed: "randomize",
        },
        derivedWidgetValues: {
          derived_widget_single_sampler_denoise: "0.2",
        },
      },
    };

    const submitted = buildSubmittedGeneration(
      {
        plan,
        request: {
          workflow: plan.workflow.workflow,
          graphData: null,
          workflowId: plan.workflow.workflowId,
          exactAspectRatio: false,
          textInputs: {},
          imageInputs: {},
          videoInputs: {},
          audioInputs: {},
          pipelineInputs: {},
          clientId: "client-id",
        },
      },
      {
        prompt_id: "prompt-1",
        number: 1,
        node_errors: {},
        applied_widget_values: {
          "94:seed": "18446744073709551615",
          "derived:single_sampler_denoise:__value": "0.4",
        },
      },
    );

    expect(
      submitted.generationMetadata.replayState?.widgetValues?.widget_94_seed,
    ).toBe("18446744073709551615");
    expect(
      submitted.generationMetadata.replayState?.widgetValues?.widget_94_steps,
    ).toBe("30");
    expect(
      submitted.generationMetadata.replayState?.derivedWidgetValues
        ?.derived_widget_single_sampler_denoise,
    ).toBe("0.4");
    expect(plan.metadata.generationMetadata.replayState?.widgetValues?.widget_94_seed)
      .toBe("11");
  });

  it("returns no cache key for text-only and randomized pipeline state", () => {
    const textOnly = makePlan("CLIPTextEncode");
    textOnly.workflow.workflowInputs = [
      {
        ...makeWorkflowInput("CLIPTextEncode"),
        inputType: "text",
        param: "text",
      },
    ];
    textOnly.preprocess.slotValues = {
      "94:text": { type: "text", value: "hello" },
    };
    expect(buildGenerationPreprocessCacheKey(textOnly)).toBeNull();

    const randomized = makePlan("LoadVideo");
    randomized.workflow.workflowRules = {
      version: 1,
      pipeline: [
        {
          id: "mask",
          kind: "mask_processing",
          controls: [
            {
              id: "strength",
              bind: {
                kind: "workflow_param",
                node_id: "94",
                param: "strength",
              },
            },
          ],
        },
      ],
    } as never;
    randomized.submission.widgetModes = {
      widget_mode_94_strength: "randomize",
    };
    expect(buildGenerationPreprocessCacheKey(randomized)).toBeNull();
  });

  it("describes every media slot, mapping, pipeline binding, and loader mode", () => {
    const plan = makePlan("VLOMemoryLoadVideo");
    plan.preprocess.slotValues = {
      image: {
        type: "image",
        file: new File(["image"], "image.png", { type: "image/png" }),
      },
      audio: {
        type: "audio",
        file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
      },
      video: {
        type: "video",
        file: new File(["video"], "video.mp4", { type: "video/mp4" }),
      },
      selection: {
        type: "video_selection",
        selection: {
          start: 0,
          end: 10,
          clips: ["clip-1"],
        },
        preparedVideoFile: new File(["prepared"], "prepared.mp4", {
          type: "video/mp4",
        }),
      },
    } as never;
    plan.preprocess.derivedMaskMappings = [
      {
        sourceNodeId: "94",
        sourceInputId: "selection",
        maskNodeId: "95",
        maskParam: "mask",
        maskType: "video",
        purpose: "generation",
        renderFps: 24,
        sourceSelection: { start: 0, end: 10, clips: [] },
        maskSelection: { start: 0, end: 10, clips: [] },
        sourceVideoTreatment: "crop",
      },
    ] as never;
    plan.workflow.workflowRules = {
      version: 1,
      pipeline: [
        {
          id: "mask",
          kind: "mask_processing",
          controls: [
            {
              id: "control",
              bind: { kind: "frontend_control", control_id: "crop" },
              default_rules: [
                {
                  when: {
                    ref: {
                      kind: "derived_widget",
                      derived_widget_id: "denoise",
                    },
                  },
                },
                {
                  when: {
                    ref: { node_id: "94", param: "strength" },
                  },
                },
              ],
            },
          ],
        },
        { id: "output", kind: "output_assembly" },
      ],
    } as never;
    plan.submission.frontendStateWidgetValues = {
      frontend_control_crop: true,
      derived_widget_denoise: 0.5,
      widget_94_strength: Number.NaN,
    };
    plan.submission.widgetInputs = {
      widget_94_disable_in_memory: "yes",
    };

    const first = buildGenerationPreprocessCacheKey(plan);
    const second = buildGenerationPreprocessCacheKey(plan);
    expect(first).toBe(second);
    expect(first).toContain("prepared.mp4");
    expect(first).toContain("frontend_control_crop");
    expect(first).toContain("derived_widget_denoise");
    expect(first).toContain("widget_94_strength");
  });

  it("finds websocket outputs and ignores malformed workflow nodes", () => {
    expect(getSaveImageWebsocketNodeIds(null)).toEqual(new Set());
    expect(
      getSaveImageWebsocketNodeIds({
        bad: null,
        array: [],
        missing: { inputs: {} },
        wrong: { class_type: 2 },
        save: { class_type: "SaveImageWebsocket" },
        bmp: { class_type: "VLOSaveImageWebsocketBMP" },
      }),
    ).toEqual(new Set(["save", "bmp"]));
  });

  it("builds isolated cache entries and merges cached pipeline output variants", () => {
    const plan = makePlan("LoadVideo");
    const prepared = {
      plan,
      request: {
        workflow: plan.workflow.workflow,
        graphData: null,
        workflowId: "workflow.json",
        exactAspectRatio: false,
        targetAspectRatio: "16:9",
        textInputs: {},
        imageInputs: {
          image: new File(["image"], "image.png", { type: "image/png" }),
        },
        videoInputs: {},
        audioInputs: {},
        pipelineInputs: { mask: { enabled: true } },
        clientId: "client",
      },
    };
    const entry = buildGenerationPreprocessCacheEntry("key", prepared, "group-1");
    prepared.request.pipelineInputs.mask.enabled = false;
    expect(entry.assets.pipelineInputs.mask?.enabled).toBe(true);

    const cached = {
      ...entry,
      backendMedia: {
        cachedMediaInputs: {},
        pipelineOutputs: { mask: { value: 1 } },
      },
    };
    expect(
      mergeCachedPipelineOutputsIntoResponse(
        { pipeline_outputs: { mask: null as never, fresh: [1] as never } },
        cached,
      ).pipeline_outputs,
    ).toEqual({ mask: null, fresh: [1] });
  });

  it("rejects incomplete backend cache references", () => {
    const entry = makeCacheEntry();
    const plan = makePlan("LoadVideo");
    expect(
      updateGenerationPreprocessCacheFromResponse(entry, plan, {}),
    ).toBe(entry);
    expect(
      updateGenerationPreprocessCacheFromResponse(entry, plan, {
        comfyui_prompt: { "94": null },
      }),
    ).toBe(entry);
    expect(
      updateGenerationPreprocessCacheFromResponse(entry, plan, {
        comfyui_prompt: {
          "94": { class_type: "LoadVideo", inputs: { file: " " } },
        },
      }),
    ).toBe(entry);
    expect(
      updateGenerationPreprocessCacheFromResponse(entry, plan, {
        comfyui_prompt: {
          "94": { class_type: "LoadVideo", inputs: { file: 12 } },
        },
      }).backendMedia?.cachedMediaInputs,
    ).toEqual({ "94": { file: 12 } });
  });

  it("prepares uncached plans and applies submission controls", async () => {
    const plan = makePlan("LoadVideo");
    plan.submission.widgetInputs = { seed: "1" };
    plan.submission.widgetModes = { seed: "fixed" };
    plan.submission.derivedWidgetInputs = { denoise: "0.5" };
    plan.submission.inputMetadata = { input: { kind: "video" } } as never;
    const request = {
      workflow: plan.workflow.workflow,
      graphData: null,
      workflowId: "workflow.json",
      exactAspectRatio: false,
      textInputs: {},
      imageInputs: {},
      videoInputs: {},
      audioInputs: {},
      pipelineInputs: {},
      clientId: "client",
    };
    frontendPreprocessMock.mockResolvedValue(request);
    const result = await prepareGenerationPlan(plan, { clientId: "client" });
    expect(frontendPreprocessMock).toHaveBeenCalled();
    expect(result.request).toMatchObject({
      widgetInputs: { seed: "1" },
      widgetModes: { seed: "fixed" },
      derivedWidgetInputs: { denoise: "0.5" },
      inputMetadata: { input: { kind: "video" } },
    });
  });

  it("creates a serializable plan and clones mutable input state", () => {
    const cyclic: Record<string, unknown> = {
      keep: "value",
      fn: () => "drop",
      symbol: Symbol("drop"),
      dom: document.createElement("div"),
      global: globalThis,
    };
    cyclic.cycle = cyclic;
    const selectionClips: TimelineClip[] = [];
    const slotValues = {
      text: { type: "text", value: "hello" },
      video: {
        type: "video_selection",
        selection: { start: 0, end: 1, clips: selectionClips },
      },
    };
    const plan = createGenerationPlan({
      workflow: cyclic,
      graphData: cyclic,
      workflowId: null,
      workflowRules: null,
      workflowInputs: [],
      workflowName: "Workflow",
      mediaInputs: {},
      slotValues: slotValues as never,
      derivedMaskMappings: [],
      exactAspectRatio: true,
      aspectRatioSelection: "auto",
      targetResolution: 1080,
      maskCropMode: "full",
      maskCropDilation: 0.2,
      widgetInputs: {},
      frontendStateWidgetValues: cyclic,
      widgetModes: {},
      derivedWidgetInputs: {},
      bypassNodeIds: ["1"],
      contributedEffects: [],
      postprocessConfig: {
        mode: "stitch_frames_with_audio",
        panel_preview: "replace_outputs",
        on_failure: "show_error",
        stitch_fps: 24,
        attach_generation_mask: false,
      },
      workflowWarnings: [],
      projectConfig: { fps: 30, aspectRatio: "16:9" },
    });
    selectionClips.push({ id: "mutated" } as TimelineClip);
    expect(plan.workflow.workflow).toEqual({ keep: "value" });
    expect(
      (plan.preprocess.slotValues.video as {
        selection: { clips: TimelineClip[] };
      })
        .selection.clips,
    ).toEqual([]);
    expect(plan.postprocess.config).toMatchObject({
      stitch_fps: 24,
      attach_generation_mask: false,
    });
    expect(plan.metadata.generationMetadata.replayState?.bypassNodeIds).toEqual(
      ["1"],
    );
  });

  it("builds submitted mask/aspect metadata and decoded mask files", () => {
    const plan = makePlan("SaveImageWebsocket");
    plan.workflow.workflowRules = {
      version: 1,
      pipeline: [
        { id: "aspect", kind: "aspect_ratio" },
        { id: "mask", kind: "mask_processing" },
      ],
    } as never;
    plan.workflow.graphData = { nodes: [] };
    const submitted = buildSubmittedGeneration(
      {
        plan,
        request: {
          workflow: {
            save: { class_type: "SaveImageWebsocket", inputs: {} },
          },
          graphData: null,
          workflowId: null,
          exactAspectRatio: false,
          textInputs: {},
          imageInputs: {},
          videoInputs: {},
          audioInputs: {},
          pipelineInputs: {},
          clientId: "client",
        },
      },
      {
        prompt_id: "prompt",
        delivery_id: "delivery",
        number: 1,
        node_errors: {},
        workflow_warnings: [{ code: "warning", message: "Warning" }],
        comfyui_prompt: { prompt: {} },
        comfyui_workflow: { ignored: true },
        pipeline_outputs: {
          aspect: {
            aspect_ratio_processing: { source: "pipeline" },
          },
          mask: {
            mask_crop_metadata: { mode: "full" },
            processed_mask_video: btoa("mask"),
          },
        },
      },
      { autoFamilyRequestKey: "family" },
    );
    expect(submitted).toMatchObject({
      deliveryId: "delivery",
      autoFamilyRequestKey: "family",
      usesSaveImageWebsocketOutputs: true,
      aspectRatioProcessing: { source: "pipeline" },
    });
    expect(submitted.preparedMaskFile).toBeInstanceOf(File);
    expect(submitted.generationMetadata).toMatchObject({
      comfyuiPrompt: { prompt: {} },
      comfyuiWorkflow: { nodes: [] },
      maskCropMetadata: { mode: "full" },
    });
  });
});
