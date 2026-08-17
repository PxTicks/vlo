import { describe, expect, it } from "vitest";
import {
  buildGenerationNodeCatalogue,
  computeGenerationCatalogueFingerprint,
} from "../workflowNodeCatalogue";

const LORA_OBJECT_INFO = {
  LoraLoader: {
    input: {
      required: {
        model: ["MODEL"],
        clip: ["CLIP"],
        lora_name: [["a.safetensors", "b.safetensors"], {}],
        strength_model: ["FLOAT", { default: 1, min: -100, max: 100, step: 0.01 }],
        strength_clip: ["FLOAT", { default: 1, min: -100, max: 100 }],
      },
    },
    input_order: {
      required: [
        "model",
        "clip",
        "lora_name",
        "strength_model",
        "strength_clip",
      ],
    },
  },
};

describe("buildGenerationNodeCatalogue", () => {
  it("returns nothing without a workflow or graph", () => {
    expect(buildGenerationNodeCatalogue(null, null, null)).toEqual([]);
  });

  it("lists every widget-backed param a class declares, not only panel-surfaced ones", () => {
    const nodes = buildGenerationNodeCatalogue(
      {
        "12": {
          class_type: "LoraLoader",
          inputs: {
            model: ["4", 0],
            clip: ["4", 1],
            lora_name: "b.safetensors",
            strength_model: 0.8,
            strength_clip: 1,
          },
          _meta: { title: "Load LoRA" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "12",
      classType: "LoraLoader",
      title: "Load LoRA",
      mode: 0,
    });
    expect(nodes[0].widgets.map((widget) => widget.param)).toEqual([
      "lora_name",
      "strength_model",
      "strength_clip",
    ]);
    expect(nodes[0].widgets[0]).toMatchObject({
      valueType: "enum",
      value: "b.safetensors",
      options: ["a.safetensors", "b.safetensors"],
      linked: false,
    });
    expect(nodes[0].widgets[1]).toMatchObject({
      valueType: "float",
      value: 0.8,
      defaultValue: 1,
      min: -100,
      max: 100,
      step: 0.01,
    });
  });

  it("marks link-fed params as linked rather than dropping the node", () => {
    const nodes = buildGenerationNodeCatalogue(
      {
        "12": {
          class_type: "LoraLoader",
          inputs: {
            model: ["4", 0],
            clip: ["4", 1],
            lora_name: ["9", 0],
            strength_model: 0.8,
            strength_clip: 1,
          },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    const loraName = nodes[0].widgets.find(
      (widget) => widget.param === "lora_name",
    );
    expect(loraName).toMatchObject({ linked: true, value: null });
  });

  it("reports muted and bypassed nodes with their graph mode", () => {
    const nodes = buildGenerationNodeCatalogue(
      null,
      LORA_OBJECT_INFO,
      {
        nodes: [
          { id: 12, type: "LoraLoader", mode: 4, widgets_values: [] },
          { id: 13, type: "LoraLoader", mode: 0, widgets_values: [] },
        ],
      },
    );

    expect(nodes.map((node) => [node.id, node.mode])).toEqual([
      ["12", 4],
      ["13", 0],
    ]);
  });

  it("keeps bypassed nodes that graphToPrompt pruned out of the prompt", () => {
    const nodes = buildGenerationNodeCatalogue(
      {
        "12": {
          class_type: "LoraLoader",
          inputs: { lora_name: "a.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      {
        nodes: [
          { id: 12, type: "LoraLoader", widgets_values: ["a.safetensors"] },
          // Bypassed, so the prompt does not contain it — but the catalogue
          // reports each node's mode, and a bypassed node must not look
          // deleted.
          { id: 13, type: "LoraLoader", mode: 4, widgets_values: ["b.safetensors"] },
        ],
      },
    );

    expect(nodes.map((node) => [node.id, node.mode])).toEqual([
      ["12", 0],
      ["13", 4],
    ]);
    expect(
      nodes[1].widgets.find((widget) => widget.param === "lora_name")?.value,
    ).toBe("b.safetensors");
  });

  it("never freezes the caller's object_info arrays", () => {
    const objectInfo = structuredClone(LORA_OBJECT_INFO);
    buildGenerationNodeCatalogue(
      { "12": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } } },
      objectInfo,
      null,
    );

    const options = objectInfo.LoraLoader.input.required.lora_name[0];
    expect(Object.isFrozen(options)).toBe(false);
    expect(() => (options as string[]).push("c.safetensors")).not.toThrow();
  });

  it("expands subgraph instances under scoped ids and prefers promoted values", () => {
    const SUBGRAPH_ID = "8a2b9d1c-2f4e-4f0a-9c11-2b0f7c3a55de";
    const nodes = buildGenerationNodeCatalogue(
      null,
      {
        RandomNoise: {
          input: {
            required: {
              noise_seed: [
                "INT",
                { control_after_generate: true, default: 0, min: 0, max: 1000 },
              ],
            },
          },
          input_order: { required: ["noise_seed"] },
        },
      },
      {
        nodes: [
          {
            id: 105,
            type: SUBGRAPH_ID,
            inputs: [],
            widgets_values: [8675309],
          },
        ],
        definitions: {
          subgraphs: [
            {
              id: SUBGRAPH_ID,
              name: "Image to Video",
              inputNode: { id: -10 },
              inputs: [
                {
                  id: "in-seed",
                  name: "noise_seed",
                  type: "INT",
                  linkIds: [21],
                },
              ],
              nodes: [
                {
                  id: 9,
                  type: "RandomNoise",
                  inputs: [
                    {
                      name: "noise_seed",
                      type: "INT",
                      widget: { name: "noise_seed" },
                      link: 21,
                    },
                  ],
                  widgets_values: [1, "randomize"],
                },
              ],
              links: [
                {
                  id: 21,
                  origin_id: -10,
                  origin_slot: 0,
                  target_id: 9,
                  target_slot: 0,
                },
              ],
            },
          ],
        },
      },
    );

    const inner = nodes.find((node) => node.id === "105:9");
    expect(inner?.widgets).toEqual([
      expect.objectContaining({
        param: "noise_seed",
        // The instance's promoted value executes, not the inner node's stale 1.
        value: 8675309,
        controlAfterGenerate: true,
        linked: false,
      }),
    ]);
  });

  it("falls back to prompt inputs when object_info has no class entry", () => {
    const nodes = buildGenerationNodeCatalogue(
      {
        "77": {
          class_type: "SomeCustomNode",
          inputs: { text: "hello", latent: ["4", 0], amount: 3 },
        },
      },
      null,
      null,
    );

    expect(nodes[0].widgets.map((widget) => [widget.param, widget.value])).toEqual([
      ["text", "hello"],
      ["amount", 3],
    ]);
    expect(nodes[0].widgets[0].valueType).toBe("string");
  });

  it("hands out frozen snapshots", () => {
    const nodes = buildGenerationNodeCatalogue(
      { "12": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } } },
      LORA_OBJECT_INFO,
      null,
    );

    expect(Object.isFrozen(nodes)).toBe(true);
    expect(Object.isFrozen(nodes[0])).toBe(true);
    expect(Object.isFrozen(nodes[0].widgets[0])).toBe(true);
  });
});

describe("computeGenerationCatalogueFingerprint", () => {
  it("tracks structure and ignores widget values", () => {
    const build = (loraName: string, mode: number) =>
      buildGenerationNodeCatalogue(
        {
          "12": {
            class_type: "LoraLoader",
            inputs: { lora_name: loraName, strength_model: 1 },
            mode,
          },
        },
        LORA_OBJECT_INFO,
        null,
      );

    expect(computeGenerationCatalogueFingerprint(build("a.safetensors", 0))).toBe(
      computeGenerationCatalogueFingerprint(build("b.safetensors", 0)),
    );
    expect(
      computeGenerationCatalogueFingerprint(build("a.safetensors", 0)),
    ).not.toBe(computeGenerationCatalogueFingerprint(build("a.safetensors", 4)));
    expect(computeGenerationCatalogueFingerprint([])).not.toBe(
      computeGenerationCatalogueFingerprint(build("a.safetensors", 0)),
    );
  });
});
