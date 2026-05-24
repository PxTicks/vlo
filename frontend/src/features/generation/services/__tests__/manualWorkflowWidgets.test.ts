import { describe, expect, it } from "vitest";
import { resolveManualWidgetInputs } from "../manualWorkflowWidgets";

describe("resolveManualWidgetInputs", () => {
  it("discovers seed-like workflow params without object_info", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "145": {
          class_type: "KSampler",
          inputs: {
            seed: 123,
            random_strength: 0.75,
            cfg: 7,
            noise_seed: ["12", 0],
          },
          _meta: { title: "Sampler" },
        },
      },
      null,
    );

    expect(widgets.map((widget) => widget.param)).toEqual([
      "seed",
      "random_strength",
    ]);
    expect(widgets[0]?.config.valueType).toBe("int");
    expect(widgets[1]?.config.valueType).toBe("float");
  });

  it("discovers control-after-generate params from object_info and graph widget values", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "145": {
          class_type: "KSampler",
          inputs: {},
          _meta: { title: "Sampler" },
        },
      },
      {
        KSampler: {
          input: {
            required: {
              seed: [
                "INT",
                {
                  control_after_generate: true,
                  default: 0,
                  min: 0,
                  max: 999,
                },
              ],
              strength: [
                "FLOAT",
                {
                  control_after_generate: true,
                  default: 0.5,
                  min: 0,
                  max: 1,
                },
              ],
            },
          },
          input_order: {
            required: ["seed", "strength"],
            optional: [],
          },
        },
      },
      {
        nodes: [
          {
            id: 145,
            title: "Sampler",
            widgets_values: [77, "randomize", 0.65, "fixed"],
          },
        ],
      },
    );

    expect(widgets.map((widget) => widget.param)).toEqual([
      "seed",
      "strength",
    ]);
    expect(widgets[0]?.currentValue).toBe(77);
    expect(widgets[0]?.config.valueType).toBe("int");
    expect(widgets[0]?.config.min).toBe(0);
    expect(widgets[0]?.config.max).toBe(999);
    expect(widgets[0]?.config.controlAfterGenerate).toBe(true);
    expect(widgets[0]?.config.defaultRandomize).toBe(true);
    expect(widgets[1]?.currentValue).toBe(0.65);
    expect(widgets[1]?.config.valueType).toBe("float");
  });

  it("only surfaces generic integer controls when the workflow randomizes them", () => {
    const widgets = resolveManualWidgetInputs(
      null,
      {
        CustomSampler: {
          input: {
            required: {
              seed: [
                "INT",
                {
                  control_after_generate: true,
                  default: 0,
                },
              ],
              batch_seed: [
                "INT",
                {
                  control_after_generate: true,
                  default: 0,
                },
              ],
              fixed_counter: [
                "INT",
                {
                  control_after_generate: true,
                  default: 1,
                },
              ],
              steps: ["INT", { default: 20 }],
            },
          },
          input_order: {
            required: ["seed", "batch_seed", "fixed_counter", "steps"],
          },
        },
      },
      {
        nodes: [
          {
            id: 50,
            type: "CustomSampler",
            title: "Custom sampler",
            widgets_values: [
              123,
              "fixed",
              456,
              "randomize",
              7,
              "fixed",
              20,
            ],
          },
        ],
      },
    );

    expect(widgets.map((widget) => widget.param)).toEqual([
      "seed",
      "batch_seed",
    ]);
    expect(widgets[0]?.config.controlAfterGenerate).toBe(true);
    expect(widgets[0]?.config.defaultRandomize).toBe(false);
    expect(widgets[1]?.config.controlAfterGenerate).toBe(true);
    expect(widgets[1]?.config.defaultRandomize).toBe(true);
  });

  it("discovers sampler controls directly from graph data", () => {
    const widgets = resolveManualWidgetInputs(
      null,
      {
        KSamplerAdvanced: {
          input: {
            required: {
              add_noise: [["enable", "disable"], {}],
              noise_seed: [
                "INT",
                {
                  control_after_generate: true,
                  default: 0,
                },
              ],
              steps: ["INT", {}],
              cfg: [
                "FLOAT",
                {
                  default: 8,
                },
              ],
            },
          },
          input_order: {
            required: ["add_noise", "noise_seed", "steps", "cfg"],
          },
        },
      },
      {
        nodes: [
          {
            id: 57,
            type: "KSamplerAdvanced",
            title: "KSampler 1",
            widgets_values: ["enable", 6332, "randomize", 10, 2],
          },
        ],
      },
    );

    expect(widgets.map((widget) => widget.param)).toEqual([
      "noise_seed",
      "cfg",
    ]);
    expect(widgets[0]?.currentValue).toBe(6332);
    expect(widgets[0]?.config.controlAfterGenerate).toBe(true);
    expect(widgets[0]?.config.defaultRandomize).toBe(true);
    expect(widgets[1]?.currentValue).toBe(2);
  });

  it("uses the node title for seed-like proxy value widgets", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "201": {
          class_type: "PrimitiveNode",
          inputs: {
            value: 456,
          },
          _meta: { title: "Seed" },
        },
      },
      null,
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.param).toBe("value");
    expect(widgets[0]?.config.label).toBe("Seed");
    expect(widgets[0]?.currentValue).toBe(456);
  });

  it("falls back to object_info display_name for proxy value widgets", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "201": {
          class_type: "PrimitiveNode",
          inputs: {
            value: 456,
          },
        },
      },
      {
        PrimitiveNode: {
          display_name: "Seed",
        },
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.config.nodeTitle).toBe("Seed");
    expect(widgets[0]?.config.label).toBe("Seed");
    expect(widgets[0]?.currentValue).toBe(456);
  });

  it("surfaces RandomNoise noise_seed from graph data when object_info is missing", () => {
    const widgets = resolveManualWidgetInputs(
      null,
      null,
      {
        nodes: [
          {
            id: 134,
            type: "RandomNoise",
            widgets_values: [524621350995903, "randomize"],
          },
        ],
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.nodeId).toBe("134");
    expect(widgets[0]?.param).toBe("noise_seed");
    expect(widgets[0]?.currentValue).toBe(524621350995903);
    expect(widgets[0]?.config.controlAfterGenerate).toBe(true);
    expect(widgets[0]?.config.defaultRandomize).toBe(true);
  });

  it("surfaces PrimitiveInt value as fallback only when its mode is randomize", () => {
    const widgets = resolveManualWidgetInputs(
      null,
      null,
      {
        nodes: [
          {
            id: 50,
            type: "PrimitiveInt",
            title: "Width",
            widgets_values: [1024, "fixed"],
          },
          {
            id: 51,
            type: "PrimitiveInt",
            title: "Random Width",
            widgets_values: [768, "randomize"],
          },
        ],
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.nodeId).toBe("51");
    expect(widgets[0]?.param).toBe("value");
    expect(widgets[0]?.currentValue).toBe(768);
    expect(widgets[0]?.config.defaultRandomize).toBe(true);
  });

  it("does not duplicate widgets when object_info path and fallback both apply", () => {
    const widgets = resolveManualWidgetInputs(
      null,
      {
        RandomNoise: {
          input: {
            required: {
              noise_seed: ["INT", { control_after_generate: true, default: 0 }],
            },
          },
          input_order: { required: ["noise_seed"] },
        },
      },
      {
        nodes: [
          {
            id: 134,
            type: "RandomNoise",
            widgets_values: [42, "randomize"],
          },
        ],
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.param).toBe("noise_seed");
    expect(widgets[0]?.currentValue).toBe(42);
  });
});
