import { describe, expect, it } from "vitest";
import {
  areInputConditionsSatisfied,
  findUnsatisfiedInputValidationRules,
  findWorkflowInputValidationFailures,
  findUnsatisfiedInputConditions,
  getClosestWorkflowResolution,
  getSupportedWorkflowResolutions,
  isWorkflowInputValidationSatisfied,
  isWorkflowInputRequired,
  normalizeWorkflowRules,
  resolvePresentedInputs,
  resolveWidgetInputs,
} from "../workflowRules";
import type { WorkflowInput } from "../../types";

function makeInferredInputs(): WorkflowInput[] {
  return [
    {
      nodeId: "6",
      classType: "CLIPTextEncode",
      inputType: "text",
      param: "text",
      label: "Prompt",
      currentValue: "hello",
      origin: "inferred",
    },
    {
      nodeId: "145",
      classType: "LoadVideo",
      inputType: "video",
      param: "file",
      label: "Load Video",
      currentValue: "a.mp4",
      origin: "inferred",
    },
  ];
}

function makeConditioningWorkflow() {
  return {
    "2": {
      class_type: "CLIPLoader",
      inputs: {},
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "a bright forest",
        clip: ["2", 0],
      },
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "blurry, low quality",
        clip: ["2", 0],
      },
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "9": {
      class_type: "KSampler",
      inputs: {
        positive: ["3", 0],
        negative: ["4", 0],
      },
    },
  } as const;
}

describe("resolvePresentedInputs", () => {
  it("normalizes valid postprocessing config", () => {
    const { rules, warnings } = normalizeWorkflowRules({
      version: 1,
      postprocessing: {
        mode: "stitch_frames_with_audio",
        panel_preview: "replace_outputs",
        on_failure: "show_error",
        stitch_fps: 24,
      },
    });

    expect(warnings).toHaveLength(0);
    expect(rules.postprocessing).toEqual({
      mode: "stitch_frames_with_audio",
      panel_preview: "replace_outputs",
      on_failure: "show_error",
      stitch_fps: 24,
    });
  });

  it("reports invalid postprocessing config and falls back to defaults", () => {
    const { rules, warnings } = normalizeWorkflowRules({
      version: 1,
      postprocessing: {
        mode: "bad_mode",
        panel_preview: 123,
        on_failure: "bad_failure",
        stitch_fps: "bad",
      },
    });

    expect(rules.postprocessing).toEqual({
      mode: "auto",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    });
    expect(
      warnings.some((warning) => warning.code === "invalid_postprocessing_mode"),
    ).toBe(true);
    expect(
      warnings.some(
        (warning) => warning.code === "invalid_postprocessing_panel_preview",
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (warning) => warning.code === "invalid_postprocessing_on_failure",
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (warning) => warning.code === "invalid_postprocessing_stitch_fps",
      ),
    ).toBe(true);
  });

  it("defaults mask cropping to crop mode and supports full mode", () => {
    const defaultResult = normalizeWorkflowRules({
      version: 1,
    });
    expect(defaultResult.rules.mask_processing?.cropping).toEqual({ mode: "crop" });

    const disabledResult = normalizeWorkflowRules({
      version: 1,
      mask_processing: {
        cropping: {
          mode: "full",
        },
      },
    });
    expect(disabledResult.warnings).toHaveLength(0);
    expect(disabledResult.rules.mask_processing?.cropping).toEqual({
      mode: "full",
    });
  });

  it("reports invalid mask cropping config and falls back to crop mode", () => {
    const { rules, warnings } = normalizeWorkflowRules({
      version: 1,
      mask_processing: {
        cropping: {
          mode: "zoom",
        },
      },
    });

    expect(rules.mask_processing?.cropping).toEqual({ mode: "crop" });
    expect(
      warnings.some(
        (warning) =>
          warning.code === "invalid_mask_processing_cropping_mode",
      ),
    ).toBe(true);
  });

  it("supports legacy boolean mask cropping config", () => {
    const { rules, warnings } = normalizeWorkflowRules({
      version: 1,
      mask_processing: {
        cropping: {
          enabled: false,
        },
      },
    });

    expect(warnings).toHaveLength(0);
    expect(rules.mask_processing?.cropping).toEqual({ mode: "full" });
  });

  it("surfaces workflow-supported aspect ratio resolutions", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      aspect_ratio_processing: {
        enabled: true,
        resolutions: [480, 720, 720],
        target_nodes: [],
        postprocess: {},
      },
    });

    const supportedResolutions = getSupportedWorkflowResolutions(rules);
    expect(supportedResolutions).toEqual([480, 720]);
    expect(getClosestWorkflowResolution(1080, supportedResolutions)).toBe(720);
  });

  it("defaults aspect ratio processing to enabled when omitted", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
    });

    expect(rules.aspect_ratio_processing?.enabled).toBe(true);
  });

  it("normalizes split aspect ratio targets", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      aspect_ratio_processing: {
        enabled: true,
        target_nodes: [
          {
            width: {
              node_id: "292",
              param: "value",
            },
            height: {
              node_id: "293",
              param: "value",
            },
          },
        ],
      },
    });

    expect(rules.aspect_ratio_processing?.target_nodes).toEqual([
      {
        width: {
          node_id: "292",
          param: "value",
        },
        height: {
          node_id: "293",
          param: "value",
        },
      },
    ]);
  });

  it("normalizes optional input presentation and input conditions", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      nodes: {
        "68": {
          present: {
            required: false,
          },
        },
      },
      input_conditions: [
        {
          kind: "at_least_one",
          inputs: ["68", "62"],
          message: "Provide at least one frame input.",
        },
      ],
    });

    expect(rules.nodes?.["68"]?.present?.required).toBe(false);
    expect(rules.input_conditions).toEqual([
      {
        kind: "at_least_one",
        inputs: ["68", "62"],
        message: "Provide at least one frame input.",
      },
    ]);
    expect(rules.validation?.inputs).toEqual([
      {
        kind: "at_least_n",
        inputs: ["68", "62"],
        min: 1,
        message: "Provide at least one frame input.",
      },
    ]);
  });

  it("preserves grouped media-input presentation metadata", () => {
    const resolved = resolvePresentedInputs(
      [
        {
          nodeId: "62",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Start frame",
          currentValue: null,
          origin: "inferred",
        },
      ],
      {
        version: 1,
        nodes: {
          "62": {
            present: {
              label: "Start frame",
              group_id: "frames",
              group_title: "Frames",
              group_order: 0,
            },
          },
        },
      },
    );

    expect(resolved.inputs[0]?.presentation).toEqual({
      group: {
        id: "frames",
        title: "Frames",
        order: 0,
      },
    });
  });

  it("evaluates input conditions against provided inputs", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      input_conditions: [
        {
          kind: "at_least_one",
          inputs: ["68", "62"],
          message: "Provide at least one frame input.",
        },
      ],
    });

    expect(findUnsatisfiedInputConditions(rules, new Set())).toEqual([
      {
        kind: "at_least_one",
        inputs: ["68", "62"],
        message: "Provide at least one frame input.",
      },
    ]);
    expect(areInputConditionsSatisfied(rules, new Set())).toBe(false);
    expect(areInputConditionsSatisfied(rules, new Set(["68"]))).toBe(true);
  });

  it("normalizes and evaluates explicit input validation rules", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      validation: {
        inputs: [
          {
            kind: "required",
            input: "3",
            message: "Prompt is required.",
          },
          {
            kind: "at_least_n",
            inputs: ["68", "62"],
            min: 1,
            message: "Provide at least one frame input.",
          },
          {
            kind: "optional",
            input: "99",
          },
        ],
      },
    });

    expect(rules.validation?.inputs).toEqual([
      {
        kind: "required",
        input: "3",
        message: "Prompt is required.",
      },
      {
        kind: "at_least_n",
        inputs: ["68", "62"],
        min: 1,
        message: "Provide at least one frame input.",
      },
      {
        kind: "optional",
        input: "99",
      },
    ]);
    expect(findUnsatisfiedInputValidationRules(rules, new Set())).toEqual([
      {
        kind: "required",
        input: "3",
        message: "Prompt is required.",
      },
      {
        kind: "at_least_n",
        inputs: ["68", "62"],
        min: 1,
        provided: 0,
        message: "Provide at least one frame input.",
      },
    ]);
  });

  it("ignores explicit validation targets that are absent from the current prompt inputs", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      validation: {
        inputs: [
          {
            kind: "required",
            input: "76",
            message: "Primary image is required.",
          },
          {
            kind: "required",
            input: "81",
            message: "Secondary image is required.",
          },
        ],
      },
    });

    const workflowInputs: WorkflowInput[] = [
      {
        nodeId: "76",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Primary image",
        currentValue: null,
        origin: "inferred",
      },
    ];

    expect(
      findWorkflowInputValidationFailures(workflowInputs, rules, new Set()),
    ).toEqual([
      {
        kind: "required",
        input: "76",
        message: "Primary image is required.",
      },
    ]);

    expect(
      findWorkflowInputValidationFailures(
        workflowInputs,
        rules,
        new Set(["76", "76:image"]),
      ),
    ).toEqual([]);
    expect(
      isWorkflowInputValidationSatisfied(
        workflowInputs,
        rules,
        new Set(["76", "76:image"]),
      ),
    ).toBe(true);
  });

  it("treats inputs as required unless explicitly marked optional", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      nodes: {
        "68": {
          present: {
            required: false,
          },
        },
      },
    });

    expect(isWorkflowInputRequired(rules, "68")).toBe(false);
    expect(isWorkflowInputRequired(rules, "62")).toBe(true);
  });

  it("builds generate-button validation failures for legacy required inputs", () => {
    const { rules } = normalizeWorkflowRules({
      version: 1,
      nodes: {
        "145": {
          present: {
            required: false,
          },
        },
      },
    });

    // Text inputs are not auto-required; only media inputs are.
    // Node "6" is text, node "145" is video (marked optional) — no failures.
    expect(
      findWorkflowInputValidationFailures(makeInferredInputs(), rules, new Set()),
    ).toEqual([]);
    expect(
      isWorkflowInputValidationSatisfied(
        makeInferredInputs(),
        rules,
        new Set(),
      ),
    ).toBe(true);
  });

  it("keeps unruled inferred inputs", () => {
    const result = resolvePresentedInputs(makeInferredInputs(), {
      version: 1,
      nodes: {},
      output_injections: {},
      slots: {},
    });

    expect(result.inputs).toHaveLength(2);
    expect(result.inputs.every((input) => input.origin === "inferred")).toBe(
      true,
    );
    expect(result.hasInferredInputs).toBe(true);
    expect(result.presentationWarnings).toHaveLength(0);
  });

  it("labels conditioning text inputs from workflow wiring", () => {
    const result = resolvePresentedInputs(
      [
        {
          nodeId: "3",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "a bright forest",
          origin: "inferred",
        },
        {
          nodeId: "4",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "blurry, low quality",
          origin: "inferred",
        },
      ],
      {
        version: 1,
        nodes: {},
        output_injections: {},
        slots: {},
      },
      makeConditioningWorkflow(),
    );

    expect(result.inputs.map((input) => input.label)).toEqual([
      "Positive Prompt",
      "Negative Prompt",
    ]);
  });

  it("places positive conditioning above negative conditioning", () => {
    const result = resolvePresentedInputs(
      [
        {
          nodeId: "4",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "blurry, low quality",
          origin: "inferred",
        },
        {
          nodeId: "3",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "a bright forest",
          origin: "inferred",
        },
      ],
      {
        version: 1,
        nodes: {},
        output_injections: {},
        slots: {},
      },
      makeConditioningWorkflow(),
    );

    expect(result.inputs.map((input) => input.nodeId)).toEqual(["3", "4"]);
    expect(result.inputs.map((input) => input.label)).toEqual([
      "Positive Prompt",
      "Negative Prompt",
    ]);
  });

  it("places start media inputs above end media inputs while preserving other positions", () => {
    const result = resolvePresentedInputs(
      [
        {
          nodeId: "77",
          classType: "VHS_LoadVideo",
          inputType: "video",
          param: "video",
          label: "Video",
          currentValue: "clip.mp4",
          origin: "inferred",
        },
        {
          nodeId: "62",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "End Image",
          currentValue: "end.png",
          origin: "inferred",
        },
        {
          nodeId: "68",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Start Image",
          currentValue: "start.png",
          origin: "inferred",
        },
      ],
      {
        version: 1,
        nodes: {},
        output_injections: {},
        slots: {},
      },
    );

    expect(result.inputs.map((input) => input.nodeId)).toEqual([
      "77",
      "68",
      "62",
    ]);
    expect(result.inputs.map((input) => input.label)).toEqual([
      "Video",
      "Start Image",
      "End Image",
    ]);
  });

  it("hides ignored nodes", () => {
    const result = resolvePresentedInputs(makeInferredInputs(), {
      version: 1,
      nodes: {
        "145": {
          ignore: true,
          present: { enabled: false },
        },
      },
      output_injections: {},
      slots: {},
    });

    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0].nodeId).toBe("6");
  });

  it("applies present overrides for existing and new nodes", () => {
    const result = resolvePresentedInputs(makeInferredInputs(), {
      version: 1,
      nodes: {
        "6": {
          present: {
            label: "Positive Prompt",
            input_type: "text",
            param: "text",
            class_type: "CLIPTextEncode",
          },
        },
        "300": {
          present: {
            label: "Control Frames",
            input_type: "video",
            param: "file",
            class_type: "ManualFramesInput",
          },
        },
      },
      output_injections: {},
      slots: {},
    });

    expect(result.inputs).toHaveLength(3);
    const promptInput = result.inputs.find((input) => input.nodeId === "6");
    expect(promptInput?.label).toBe("Positive Prompt");
    expect(promptInput?.origin).toBe("rule");

    const manualInput = result.inputs.find((input) => input.nodeId === "300");
    expect(manualInput?.inputType).toBe("video");
    expect(manualInput?.origin).toBe("rule");
  });

  it("preserves explicit rule labels over inferred conditioning labels", () => {
    const result = resolvePresentedInputs(
      [
        {
          nodeId: "3",
          classType: "CLIPTextEncode",
          inputType: "text",
          param: "text",
          label: "Prompt",
          currentValue: "a bright forest",
          origin: "inferred",
        },
      ],
      {
        version: 1,
        nodes: {
          "3": {
            present: {
              label: "Primary Prompt",
            },
          },
        },
        output_injections: {},
        slots: {},
      },
      makeConditioningWorkflow(),
    );

    expect(result.inputs[0]?.label).toBe("Primary Prompt");
  });

  it("attaches node selection config to direct video inputs", () => {
    const result = resolvePresentedInputs(makeInferredInputs(), {
      version: 1,
      nodes: {
        "145": {
          selection: {
            export_fps: 16,
            frame_step: 4,
            max_frames: 81,
          },
        },
      },
      output_injections: {},
      slots: {},
    });

    expect(result.presentationWarnings).toHaveLength(0);
    expect(result.inputs.find((input) => input.nodeId === "145")?.dispatch).toEqual({
      kind: "node",
      selectionConfig: {
        exportFps: 16,
        frameStep: 4,
        maxFrames: 81,
      },
    });
  });

  it("keeps widget datatype metadata from rules", () => {
    const workflow = {
      "145": {
        inputs: {
          seed: 1,
          sampler_name: "euler",
        },
      },
    } as const;

    const widgets = resolveWidgetInputs(workflow, {
      version: 1,
      nodes: {
        "145": {
          node_title: "KSampler",
          widgets: {
            seed: {
              label: "Seed",
              control_after_generate: true,
              value_type: "int",
              min: 0,
              max: 18446744073709552000,
            },
            sampler_name: {
              label: "Sampler",
              value_type: "enum",
              options: ["euler", "heun"],
            },
          },
        },
      },
      output_injections: {},
      slots: {},
    });

    expect(widgets).toHaveLength(2);
    const seed = widgets.find((widget) => widget.param === "seed");
    const sampler = widgets.find((widget) => widget.param === "sampler_name");

    expect(seed?.config.nodeTitle).toBe("KSampler");
    expect(seed?.config.valueType).toBe("int");
    expect(seed?.config.min).toBe(0);
    expect(seed?.config.max).toBe(18446744073709552000);

    expect(sampler?.config.valueType).toBe("enum");
    expect(sampler?.config.options).toEqual(["euler", "heun"]);
  });

  it("skips stale widget rules whose params are no longer present in the workflow", () => {
    const widgets = resolveWidgetInputs(
      {
        "145": {
          inputs: {
            cfg: 7,
          },
        },
      },
      {
        version: 1,
        nodes: {
          "145": {
            widgets: {
              steps: {
                value_type: "int",
              },
              cfg: {
                value_type: "float",
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.param).toBe("cfg");
  });

  it("keeps default-backed widgets even when the workflow omits the raw input param", () => {
    const widgets = resolveWidgetInputs(
      {
        "145": {
          inputs: {},
        },
      },
      {
        version: 1,
        nodes: {
          "145": {
            widgets: {
              sampler_name: {
                value_type: "enum",
                options: ["euler", "heun"],
                default: "euler",
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.param).toBe("sampler_name");
    expect(widgets[0]?.currentValue).toBe("euler");
  });

  it("maps stored boolean widget values to custom workflow values", () => {
    const widgets = resolveWidgetInputs(
      {
        "349": {
          inputs: {
            sampling_mode: "off",
          },
        },
      },
      {
        version: 1,
        nodes: {
          "349": {
            widgets: {
              sampling_mode: {
                label: "Enable prompt enhancer",
                value_type: "boolean",
                default: false,
                true_value: "on",
                false_value: "off",
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.config.valueType).toBe("boolean");
    expect(widgets[0]?.config.trueValue).toBe("on");
    expect(widgets[0]?.config.falseValue).toBe("off");
    expect(widgets[0]?.currentValue).toBe(false);
  });

  it("omits hidden noise widgets while keeping the visible generation seed", () => {
    const widgets = resolveWidgetInputs(
      {
        "114": {
          inputs: {
            noise_seed: 42,
          },
        },
        "115": {
          inputs: {
            noise_seed: 43,
          },
        },
      },
      {
        version: 1,
        nodes: {
          "114": {
            widgets: {
              noise_seed: {
                label: "Upscale noise seed",
                control_after_generate: true,
                value_type: "int",
                hidden: true,
              },
            },
          },
          "115": {
            widgets: {
              noise_seed: {
                label: "Noise seed",
                control_after_generate: true,
                value_type: "int",
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.nodeId).toBe("115");
    expect(widgets[0]?.param).toBe("noise_seed");
    expect(widgets[0]?.currentValue).toBe(43);
  });

  it("preserves widget grouping metadata for proxy-backed controls", () => {
    const widgets = resolveWidgetInputs(
      {
        "267:257": {
          inputs: {
            value: 1280,
          },
        },
        "267:258": {
          inputs: {
            value: 720,
          },
        },
      },
      {
        version: 1,
        nodes: {
          "267:257": {
            node_title: "Width",
            widgets: {
              value: {
                label: "Width",
                control_after_generate: true,
                value_type: "int",
                group_id: "267",
                group_title: "Video Generation (LTX-2.3)",
                group_order: 4,
              },
            },
          },
          "267:258": {
            node_title: "Height",
            widgets: {
              value: {
                label: "Height",
                control_after_generate: true,
                value_type: "int",
                group_id: "267",
                group_title: "Video Generation (LTX-2.3)",
                group_order: 5,
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(2);
    expect(widgets[0]?.config.groupId).toBe("267");
    expect(widgets[0]?.config.groupTitle).toBe("Video Generation (LTX-2.3)");
    expect(widgets[0]?.config.groupOrder).toBe(4);
    expect(widgets[1]?.config.groupId).toBe("267");
    expect(widgets[1]?.config.groupOrder).toBe(5);
  });

  it("preserves frontend-only widget metadata for UI-only controls", () => {
    const widgets = resolveWidgetInputs(
      {
        "145": {
          inputs: {},
        },
      },
      {
        version: 1,
        nodes: {
          "145": {
            widgets: {
              derived_mask_source_video_treatment: {
                label: "Transparency handling",
                value_type: "enum",
                options: [
                  "Keep transparency",
                  "Fill transparent with neutral gray",
                  "Remove transparency",
                ],
                default: "Keep transparency",
                frontend_only: true,
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.config.frontendOnly).toBe(true);
    expect(widgets[0]?.config.defaultValue).toBe("Keep transparency");
    expect(widgets[0]?.param).toBe("derived_mask_source_video_treatment");
  });

  it("normalizes the legacy derived mask treatment widget alias", () => {
    const { rules, warnings } = normalizeWorkflowRules({
      version: 1,
      nodes: {
        "145": {
          widgets: {
            __derived_mask_video_treatment: {
              label: "Transparency handling",
              value_type: "enum",
              default: "Keep transparency",
              frontend_only: true,
            },
          },
        },
      },
    });

    expect(
      rules.nodes?.["145"]?.widgets?.derived_mask_source_video_treatment,
    ).toMatchObject({
      label: "Transparency handling",
      value_type: "enum",
      default: "Keep transparency",
      frontend_only: true,
    });
    expect(
      rules.nodes?.["145"]?.widgets?.__derived_mask_video_treatment,
    ).toBeUndefined();
    expect(
      warnings.some((warning) => warning.code === "deprecated_widget_param_alias"),
    ).toBe(true);
  });

  it("resolves dual-sampler denoise as a derived slider and hides backing widgets", () => {
    const widgets = resolveWidgetInputs(
      {
        "145": {
          inputs: {
            steps: 10,
            start_step: 2,
            split_step: 4,
          },
        },
        "146": {
          inputs: {
            start_at_step: 4,
          },
        },
      },
      {
        version: 1,
        nodes: {
          "145": {
            widgets: {
              start_step: {
                value_type: "int",
                hidden: true,
              },
              split_step: {
                value_type: "int",
                hidden: true,
              },
            },
          },
          "146": {
            widgets: {
              start_at_step: {
                value_type: "int",
                hidden: true,
              },
            },
          },
        },
        derived_widgets: [
          {
            id: "denoise",
            kind: "dual_sampler_denoise",
            label: "Denoise",
            total_steps: {
              node_id: "145",
              param: "steps",
            },
            start_step: {
              node_id: "145",
              param: "start_step",
            },
            base_split_step: {
              node_id: "145",
              param: "split_step",
            },
            split_step_targets: [
              {
                node_id: "145",
                param: "split_step",
              },
              {
                node_id: "146",
                param: "start_at_step",
              },
            ],
          },
        ],
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.kind).toBe("derived");
    expect(widgets[0]?.nodeId).toBe("derived:denoise");
    expect(widgets[0]?.config.groupTitle).toBe("Denoise");
    expect(widgets[0]?.config.control).toBe("slider");
    expect(widgets[0]?.config.min).toBe(0.1);
    expect(widgets[0]?.config.step).toBe(0.1);
    expect(widgets[0]?.currentValue).toBe(0.8);
  });

  it("preserves raw slider widget metadata for numeric controls", () => {
    const widgets = resolveWidgetInputs(
      {
        "291": {
          inputs: {
            value: 10,
          },
        },
      },
      {
        version: 1,
        nodes: {
          "291": {
            widgets: {
              value: {
                label: "Duration",
                value_type: "float",
                control: "slider",
                slider_display: "number",
                unit: "s",
                min: 1 / 3,
                max: 20,
                step: 1 / 3,
              },
            },
          },
        },
        output_injections: {},
        slots: {},
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.config.control).toBe("slider");
    expect(widgets[0]?.config.sliderDisplay).toBe("number");
    expect(widgets[0]?.config.unit).toBe("s");
    expect(widgets[0]?.config.step).toBeCloseTo(1 / 3);
  });
});
