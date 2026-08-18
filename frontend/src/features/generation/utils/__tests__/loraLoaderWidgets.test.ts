import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import { buildGenerationNodeCatalogue } from "../../services/workflowNodeCatalogue";
import {
  LORA_BYPASS_CHOICE,
  LORA_LOADERS_SECTION_ID,
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../loraLoaderWidgets";

const LORA_OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [["base.safetensors", "detail.safetensors"], {}],
        strength_model: ["FLOAT", { default: 1 }],
      },
    },
    input_order: {
      required: ["model", "lora_name", "strength_model"],
    },
  },
};

function discoverLoraWidgets(
  workflow: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
  graphData: Record<string, unknown> | null,
) {
  return resolveAutodiscoveredLoraWidgetInputs(
    buildGenerationNodeCatalogue(workflow, objectInfo, graphData),
  );
}

describe("autodiscovered LoRA widget inputs", () => {
  it("creates ordinary widget inputs for active root and scoped loaders", () => {
    const subgraphId = "lora-definition";
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: {
            model: ["1", 0],
            lora_name: "detail.safetensors",
            strength_model: 0.8,
          },
          _meta: { title: "Portrait detail" },
        },
      },
      LORA_OBJECT_INFO,
      {
        nodes: [
          {
            id: 4,
            type: "LoraLoaderModelOnly",
            title: "Portrait detail",
            widgets_values: ["detail.safetensors", 0.8],
          },
          { id: 12, type: subgraphId, inputs: [] },
        ],
        definitions: {
          subgraphs: [
            {
              id: subgraphId,
              name: "Nested LoRA",
              inputs: [],
              nodes: [
                {
                  id: 6,
                  type: "LoraLoaderModelOnly",
                  widgets_values: ["base.safetensors", 1],
                },
              ],
              links: [],
            },
          ],
        },
      },
    );

    expect(widgets.map((widget) => widget.nodeId)).toEqual(["4", "12:6"]);
    expect(widgets[0]).toMatchObject({
      param: "lora_name",
      currentValue: "detail.safetensors",
      config: {
        label: "Model",
        groupTitle: "Portrait detail",
        sectionId: LORA_LOADERS_SECTION_ID,
        options: ["base.safetensors", "detail.safetensors"],
        nodeBypassOption: {
          value: LORA_BYPASS_CHOICE,
          label: "None (bypass)",
        },
      },
    });
  });

  it("skips linked, muted, and non-LoRA nodes", () => {
    const widgets = discoverLoraWidgets(
      {
        linked: {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: ["upstream", 0] },
        },
        muted: {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
        other: {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "model.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      {
        nodes: [
          {
            id: "linked",
            type: "LoraLoaderModelOnly",
            inputs: [{ name: "lora_name", link: 1 }],
            widgets_values: ["base.safetensors", 1],
          },
          {
            id: "muted",
            type: "LoraLoaderModelOnly",
            mode: 2,
            widgets_values: ["base.safetensors", 1],
          },
          { id: "other", type: "CheckpointLoaderSimple" },
        ],
      },
    );

    expect(widgets).toEqual([]);
  });

  it("preserves an unavailable workflow model instead of clamping to the first installed model", () => {
    const widgets = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "missing.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    expect(widgets[0]).toMatchObject({
      currentValue: "missing.safetensors",
      config: {
        options: ["base.safetensors", "detail.safetensors"],
      },
    });
  });

  it("enhances an explicitly presented widget without replacing its metadata", () => {
    const explicit: WorkflowWidgetInput = {
      nodeId: "4",
      param: "lora_name",
      currentValue: "base.safetensors",
      config: {
        label: "Style adapter",
        controlAfterGenerate: false,
        valueType: "enum",
        options: ["base.safetensors", "detail.safetensors"],
        sectionId: "models",
        groupTitle: "Custom models",
      },
    };
    const discovered = discoverLoraWidgets(
      {
        "4": {
          class_type: "LoraLoaderModelOnly",
          inputs: { lora_name: "base.safetensors" },
        },
      },
      LORA_OBJECT_INFO,
      null,
    );

    expect(mergeAutodiscoveredLoraWidgetInputs([explicit], discovered)).toEqual([
      {
        ...explicit,
        config: {
          ...explicit.config,
          nodeBypassOption: {
            value: LORA_BYPASS_CHOICE,
            label: "None (bypass)",
          },
        },
      },
    ]);
  });
});
