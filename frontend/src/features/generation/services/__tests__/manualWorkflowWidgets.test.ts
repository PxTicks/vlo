import { describe, expect, it } from "vitest";
import { resolveManualWidgetInputs } from "../manualWorkflowWidgets";

describe("resolveManualWidgetInputs", () => {
  it("returns no widgets without workflow or graph data", () => {
    expect(resolveManualWidgetInputs(null, null)).toEqual([]);
  });

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

  it("ignores malformed, missing-id, and disabled graph nodes", () => {
    const widgets = resolveManualWidgetInputs(null, null, {
      nodes: [
        null,
        "bad",
        { type: "RandomNoise", widgets_values: [1, "randomize"] },
        {
          id: 1,
          type: "RandomNoise",
          mode: 2,
          widgets_values: [2, "randomize"],
        },
        {
          id: 2,
          type: "RandomNoise",
          mode: 4,
          widgets_values: [3, "randomize"],
        },
        {
          id: 3,
          type: "RandomNoise",
          widgets_values: [4, "randomize"],
        },
      ],
    });

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ nodeId: "3", currentValue: 4 });
  });

  it("ignores malformed and muted workflow nodes, including graph-muted nodes", () => {
    const widgets = resolveManualWidgetInputs(
      {
        invalid: "node",
        muted: {
          class_type: "RandomNoise",
          mode: 2,
          inputs: { noise_seed: 1 },
        },
        bypassed: {
          class_type: "RandomNoise",
          mode: 4,
          inputs: { noise_seed: 2 },
        },
        graphMuted: {
          class_type: "RandomNoise",
          inputs: { noise_seed: 3 },
        },
        active: {
          class_type: "RandomNoise",
          inputs: { noise_seed: 4 },
        },
      },
      null,
      {
        nodes: [{ id: "graphMuted", mode: 2 }],
      },
    );

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ nodeId: "active", currentValue: 4 });
  });

  it("supports optional definitions, combo options, booleans, strings, and bounds", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "1": {
          class_type: "Custom",
          inputs: {
            random_choice: "b",
            random_enabled: true,
            random_label: "hello",
          },
        },
      },
      {
        Custom: {
          input: {
            optional: {
              random_choice: [
                "COMBO",
                { options: ["a", "b", 3, true, null], default: "a" },
              ],
              random_enabled: ["BOOLEAN", { default: false }],
              random_label: [
                "STRING",
                { default: "", min: 1, max: 20, step: 2 },
              ],
            },
          },
          input_order: {
            required: [null, "", 4],
            optional: [
              "random_choice",
              "random_enabled",
              "random_label",
            ],
          },
        },
      },
    );

    expect(widgets.map((widget) => widget.config.valueType)).toEqual([
      "enum",
      "boolean",
      "string",
    ]);
    expect(widgets[0]?.config.options).toEqual(["a", "b", 3, true]);
    expect(widgets[2]?.config).toMatchObject({ min: 1, max: 20, step: 2 });
  });

  it("skips linked, unsupported, and valueless widget candidates", () => {
    const widgets = resolveManualWidgetInputs(
      {
        "1": {
          class_type: "Custom",
          inputs: {
            random_link: ["2", 0],
          },
        },
      },
      {
        Custom: {
          input: {
            required: {
              random_link: ["INT", {}],
              random_unsupported: ["MODEL", {}],
              random_missing: ["FLOAT", {}],
              malformed: [],
            },
          },
        },
      },
    );

    expect(widgets).toEqual([]);
  });

  it.each([
    ["increment", false],
    ["decrement", false],
    ["fixed", false],
    ["randomize", true],
    ["unexpected", undefined],
  ])("maps %s control mode to randomize=%s", (mode, defaultRandomize) => {
    const widgets = resolveManualWidgetInputs(
      null,
      {
        PrimitiveInt: {
          display_name: "Random Value",
          input: {
            required: {
              value: [
                "INT",
                { control_after_generate: "fixed", default: 5 },
              ],
            },
          },
          input_order: { required: ["value"] },
        },
      },
      {
        nodes: [
          {
            id: 1,
            type: "PrimitiveInt",
            title: "Random Value",
            widgets_values: [7, mode],
          },
        ],
      },
    );

    expect(widgets[0]?.config.defaultRandomize).toBe(defaultRandomize);
  });

  it("uses fallback slot ordering and null values when object info is absent", () => {
    const widgets = resolveManualWidgetInputs(null, null, {
      nodes: [
        {
          id: 1,
          type: "KSampler",
          widgets_values: [11, "increment", 20, 7, "euler", "normal", 1],
        },
        {
          id: 2,
          type: "RandomNoise",
          widgets_values: [],
        },
        {
          id: 3,
          type: "Unknown",
          widgets_values: [99, "randomize"],
        },
      ],
    });

    expect(widgets).toEqual([
      expect.objectContaining({
        nodeId: "1",
        param: "seed",
        currentValue: 11,
      }),
      expect.objectContaining({
        nodeId: "2",
        param: "noise_seed",
        currentValue: null,
      }),
    ]);
    expect(widgets[0]?.config.defaultRandomize).toBe(false);
    expect(widgets[1]?.config.defaultRandomize).toBeUndefined();
  });
});
