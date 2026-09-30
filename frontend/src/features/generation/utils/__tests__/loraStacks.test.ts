import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowWidgetInput } from "../../types";
import {
  resolveWidgetInputs,
  type WorkflowRules,
} from "../../services/workflowRules";
import { buildGenerationNodeCatalogue } from "../../services/workflowNodeCatalogue";
import {
  LORA_LOADERS_SECTION_ID,
  collectBypassDiscoveryNodeIds,
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../loraLoaderWidgets";
import {
  collectLoraStackDiagnostics,
  collectLoraStackNodeIds,
  packLoraStacks,
  presentLoraStackWidgetInputs,
} from "../loraStacks";
import {
  collectDefaultNodeBypassWidgetTargets,
  getNodeBypassWidgetKey,
} from "../nodeBypassWidgets";
import { collectWidgetSubmissionState } from "../widgetSubmissionState";
import type { WidgetValueMap } from "../widgetValueReconciliation";

const LORAS = ["a.safetensors", "b.safetensors", "c.safetensors"];

const OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [LORAS, {}],
        strength_model: ["FLOAT", { default: 1, min: -10, max: 10 }],
      },
    },
    input_order: { required: ["model", "lora_name", "strength_model"] },
  },
  LoraLoader: {
    input: {
      required: {
        model: ["MODEL"],
        clip: ["CLIP"],
        lora_name: [LORAS, {}],
        strength_model: ["FLOAT", { default: 1 }],
        strength_clip: ["FLOAT", { default: 1 }],
      },
    },
    input_order: {
      required: ["model", "clip", "lora_name", "strength_model", "strength_clip"],
    },
  },
  KSampler: {
    input: { required: { seed: ["INT", { default: 0 }] } },
    input_order: { required: ["seed"] },
  },
};

interface GraphNodeSpec {
  id: number;
  mode?: number;
  type?: string;
  widgets?: unknown[];
}

function discover(nodes: GraphNodeSpec[], rules: WorkflowRules) {
  const graph = {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? "LoraLoaderModelOnly",
      mode: node.mode ?? 4,
      widgets_values: node.widgets ?? ["a.safetensors", 1],
    })),
  };
  const catalogue = buildGenerationNodeCatalogue(null, OBJECT_INFO, graph);
  const widgetInputs = [
    ...resolveAutodiscoveredLoraWidgetInputs(
      catalogue,
      collectLoraStackNodeIds(rules),
    ),
  ];
  return { catalogue, widgetInputs };
}

const STACK_RULES = {
  version: 3,
  lora_stacks: [{ id: "model", nodes: ["150", "153", "154", "155"] }],
} as unknown as WorkflowRules;

const FOUR_BYPASSED: GraphNodeSpec[] = [
  { id: 150 },
  { id: 153 },
  { id: 154 },
  { id: 155 },
];

const key = (nodeId: string) => getNodeBypassWidgetKey(nodeId, "lora_name");

/** The targets a freshly mounted panel starts with: every shipped-off loader. */
function mountedTargets(widgetInputs: readonly WorkflowWidgetInput[]) {
  return new Set(collectDefaultNodeBypassWidgetTargets(widgetInputs));
}

/** Visible groups in render order, as title → node id. */
function visibleSlots(presented: readonly WorkflowWidgetInput[]) {
  return presented
    .filter(
      (widget) => widget.param === "lora_name" && widget.config.hidden !== true,
    )
    .map((widget) => [widget.config.groupTitle, widget.nodeId]);
}

describe("LoRA stack discovery", () => {
  it("discovers every stack member even though they ship bypassed", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);

    expect(
      widgetInputs
        .filter((widget) => widget.param === "lora_name")
        .map((widget) => widget.nodeId),
    ).toEqual(["150", "153", "154", "155"]);
    expect(collectLoraStackNodeIds(null).size).toBe(0);
  });
});

describe("presentLoraStackWidgetInputs", () => {
  it("shows a single empty slot when every member ships bypassed", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);

    const presented = presentLoraStackWidgetInputs(
      widgetInputs,
      STACK_RULES,
      mountedTargets(widgetInputs),
    );

    expect(visibleSlots(presented)).toEqual([["LoRA 1", "150"]]);
    // Hidden members stay listed, so their bypass still reaches submission.
    expect(presented).toHaveLength(widgetInputs.length);
  });

  it("reveals the next slot once a model is selected, up to the last member", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const targets = mountedTargets(widgetInputs);

    targets.delete(key("150"));
    expect(
      visibleSlots(
        presentLoraStackWidgetInputs(widgetInputs, STACK_RULES, targets),
      ),
    ).toEqual([
      ["LoRA 1", "150"],
      ["LoRA 2", "153"],
    ]);

    for (const nodeId of ["153", "154", "155"]) targets.delete(key(nodeId));
    expect(
      visibleSlots(
        presentLoraStackWidgetInputs(widgetInputs, STACK_RULES, targets),
      ),
    ).toEqual([
      ["LoRA 1", "150"],
      ["LoRA 2", "153"],
      ["LoRA 3", "154"],
      ["LoRA 4", "155"],
    ]);
  });

  it("drops an emptied slot from the list instead of leaving a gap", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    // 150 and 154 selected; 153 set back to None.
    const targets = new Set([key("153"), key("155")]);

    expect(
      visibleSlots(
        presentLoraStackWidgetInputs(widgetInputs, STACK_RULES, targets),
      ),
    ).toEqual([
      ["LoRA 1", "150"],
      ["LoRA 2", "154"],
      ["LoRA 3", "153"],
    ]);
  });

  it("shows a member that ships active, with its value, as a selected slot", () => {
    const { widgetInputs } = discover(
      [
        { id: 150 },
        { id: 153, mode: 0, widgets: ["c.safetensors", 0.7] },
        { id: 154 },
      ],
      STACK_RULES,
    );
    const presented = presentLoraStackWidgetInputs(
      widgetInputs,
      STACK_RULES,
      mountedTargets(widgetInputs),
    );

    expect(visibleSlots(presented)).toEqual([
      ["LoRA 1", "153"],
      ["LoRA 2", "150"],
    ]);
    const active = presented.find(
      (widget) => widget.nodeId === "153" && widget.param === "lora_name",
    );
    expect(active?.currentValue).toBe("c.safetensors");
  });

  it("carries each loader's strength with its slot", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const presented = presentLoraStackWidgetInputs(
      widgetInputs,
      STACK_RULES,
      mountedTargets(widgetInputs),
    );

    const strengths = presented.filter(
      (widget) => widget.param === "strength_model",
    );
    const first = strengths.find((widget) => widget.nodeId === "150");
    expect(first?.config.hidden).not.toBe(true);
    expect(first?.config).toMatchObject({
      groupId: "lora-stack:model:150",
      groupTitle: "LoRA 1",
      sectionId: LORA_LOADERS_SECTION_ID,
    });
    expect(
      strengths
        .filter((widget) => widget.nodeId !== "150")
        .every((widget) => widget.config.hidden === true),
    ).toBe(true);
    // The model dropdown stays ahead of its strength inside the group.
    const firstGroup = presented.filter(
      (widget) => widget.config.groupId === "lora-stack:model:150",
    );
    expect(firstGroup.map((widget) => widget.param)).toEqual([
      "lora_name",
      "strength_model",
    ]);
  });

  it("applies the stack's section, title and order", () => {
    const rules = {
      version: 3,
      lora_stacks: [
        {
          id: "style",
          nodes: ["150", "153"],
          section_id: "advanced_settings",
          group_title: "Style LoRA",
          group_order: 5,
        },
      ],
    } as unknown as WorkflowRules;
    const { widgetInputs } = discover([{ id: 150 }, { id: 153 }], rules);

    const [model] = presentLoraStackWidgetInputs(
      widgetInputs,
      rules,
      mountedTargets(widgetInputs),
    );

    expect(model?.config).toMatchObject({
      sectionId: "advanced_settings",
      groupTitle: "Style LoRA 1",
      groupOrder: 5,
    });
  });

  it("leaves the list untouched without stacks", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);

    expect(
      presentLoraStackWidgetInputs(
        widgetInputs,
        { version: 3 } as WorkflowRules,
        new Set(),
      ),
    ).toBe(widgetInputs);
  });

  it("keeps unstacked widgets in place around the stack", () => {
    const rules = {
      version: 3,
      lora_stacks: [{ id: "model", nodes: ["153", "150"] }],
    } as unknown as WorkflowRules;
    const { widgetInputs } = discover(
      [{ id: 150 }, { id: 153 }, { id: 200, mode: 0 }],
      rules,
    );

    const presented = presentLoraStackWidgetInputs(
      widgetInputs,
      rules,
      new Set([key("150"), key("153")]),
    );

    // Stack order, not graph order, decides the first slot.
    expect(visibleSlots(presented)[0]).toEqual(["LoRA 1", "153"]);
    expect(presented.at(-1)?.nodeId).toBe("200");
    expect(presented.at(-1)?.config.groupTitle).not.toMatch(/^LoRA \d/);
  });
});

/**
 * Strengths of a bypassed loader are still written, as for any unstacked
 * loader; the node is off, so only the model writes say where LoRAs land.
 */
function modelOverrides(overrides: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(overrides).filter(([name]) => name.endsWith("_lora_name")),
  );
}

describe("packLoraStacks", () => {
  function submit(
    widgetInputs: readonly WorkflowWidgetInput[],
    widgetValues: WidgetValueMap,
    targets: ReadonlySet<string>,
    rules: WorkflowRules = STACK_RULES,
  ) {
    const packed = packLoraStacks({
      widgetInputs,
      widgetValues,
      bypassedWidgetTargets: targets,
      rules,
    });
    return collectWidgetSubmissionState({
      widgetInputs,
      widgetValues: packed.widgetValues,
      randomizeToggles: {},
      bypassedWidgetTargets: packed.bypassedWidgetTargets,
    });
  }

  it("packs selections into the leading loaders, in order", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const values: WidgetValueMap = {
      "153": { lora_name: "b.safetensors", strength_model: 0.5 },
      "155": { lora_name: "c.safetensors", strength_model: 0.25 },
    };

    const submission = submit(
      widgetInputs,
      values,
      new Set([key("150"), key("154")]),
    );

    expect(modelOverrides(submission.widgetOverrides)).toEqual({
      widget_150_lora_name: "b.safetensors",
      widget_153_lora_name: "c.safetensors",
    });
    expect(submission.widgetOverrides).toMatchObject({
      widget_150_strength_model: "0.5",
      widget_153_strength_model: "0.25",
    });
    expect(submission.activateNodeIds.sort()).toEqual(["150", "153"]);
    // The trailing loaders ship bypassed and stay that way with no effect.
    expect(submission.bypassNodeIds).toEqual([]);
  });

  it("bypasses a member that ships active once it is packed empty", () => {
    const { widgetInputs } = discover(
      [
        { id: 150, mode: 0, widgets: ["a.safetensors", 1] },
        { id: 153, mode: 0, widgets: ["b.safetensors", 1] },
      ],
      STACK_RULES,
    );

    // The user sets the first loader to None: the second moves up.
    const submission = submit(widgetInputs, {}, new Set([key("150")]));

    expect(submission.widgetOverrides).toMatchObject({
      widget_150_lora_name: "b.safetensors",
    });
    expect(submission.bypassNodeIds).toEqual(["153"]);
    expect(submission.activateNodeIds).toEqual([]);
  });

  it("submits nothing but bypasses for an untouched stack", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);

    const submission = submit(widgetInputs, {}, mountedTargets(widgetInputs));

    expect(modelOverrides(submission.widgetOverrides)).toEqual({});
    expect(submission.activateNodeIds).toEqual([]);
    expect(submission.bypassNodeIds).toEqual([]);
  });

  it("leaves the panel's own values alone", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const values: WidgetValueMap = { "155": { lora_name: "c.safetensors" } };
    const targets = new Set([key("150"), key("153"), key("154")]);

    const packed = packLoraStacks({
      widgetInputs,
      widgetValues: values,
      bypassedWidgetTargets: targets,
      rules: STACK_RULES,
    });

    expect(packed.widgetValues).not.toBe(values);
    expect(values).toEqual({ "155": { lora_name: "c.safetensors" } });
    expect([...targets]).toEqual([key("150"), key("153"), key("154")]);
  });

  it("never packs into a member the panel cannot show", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    // A sidecar hid the first member's dropdown.
    const withHidden = widgetInputs.map((widget) =>
      widget.nodeId === "150" && widget.param === "lora_name"
        ? { ...widget, config: { ...widget.config, hidden: true } }
        : widget,
    );

    const submission = submit(
      withHidden,
      { "154": { lora_name: "b.safetensors" } },
      new Set([key("150"), key("153"), key("155")]),
    );

    expect(submission.widgetOverrides).toMatchObject({
      widget_153_lora_name: "b.safetensors",
    });
    expect(submission.activateNodeIds).toEqual(["153"]);
  });

  it("carries only the strengths the receiving loader has", () => {
    const { widgetInputs } = discover(
      [
        { id: 150 },
        {
          id: 153,
          type: "LoraLoader",
          widgets: ["b.safetensors", 0.5, 0.25],
        },
      ],
      STACK_RULES,
    );

    const submission = submit(
      widgetInputs,
      { "153": { strength_model: 0.5, strength_clip: 0.25 } },
      new Set([key("150")]),
    );

    expect(modelOverrides(submission.widgetOverrides)).toEqual({
      widget_150_lora_name: "b.safetensors",
    });
    expect(submission.widgetOverrides.widget_150_strength_model).toBe("0.5");
    expect(submission.widgetOverrides).not.toHaveProperty(
      "widget_150_strength_clip",
    );
  });

  it("is a no-op without stacks", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const values: WidgetValueMap = {};
    const targets = new Set<string>();

    const packed = packLoraStacks({
      widgetInputs,
      widgetValues: values,
      bypassedWidgetTargets: targets,
      rules: null,
    });

    expect(packed.widgetValues).toBe(values);
    expect(packed.bypassedWidgetTargets).toBe(targets);
  });
});

describe("collectLoraStackDiagnostics", () => {
  it("reports members the panel cannot use and mixed loader classes", () => {
    const rules = {
      version: 3,
      lora_stacks: [{ id: "model", nodes: ["150", "153", "154", "155"] }],
    } as unknown as WorkflowRules;
    const { catalogue } = discover(
      [
        { id: 150 },
        { id: 153, type: "LoraLoader", widgets: ["a.safetensors", 1, 1] },
        { id: 154, type: "KSampler", widgets: [1] },
        { id: 155, mode: 2 },
      ],
      rules,
    );

    const diagnostics = collectLoraStackDiagnostics(catalogue, rules);

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toMatch(/node 154 .*not a LoRA loader/);
    expect(diagnostics[1]).toMatch(/node 155 .*ships muted/);
    expect(diagnostics[2]).toMatch(
      /mixes loader classes LoraLoaderModelOnly, LoraLoader/,
    );
  });

  it("is quiet for a uniform stack", () => {
    const { catalogue } = discover(FOUR_BYPASSED, STACK_RULES);

    expect(collectLoraStackDiagnostics(catalogue, STACK_RULES)).toEqual([]);
  });
});

describe("sidecar controls on a stacked loader", () => {
  /** A non-strength control a sidecar exposes on loader 153, elsewhere. */
  function withSidecarControl(widgetInputs: readonly WorkflowWidgetInput[]) {
    const control: WorkflowWidgetInput = {
      nodeId: "153",
      param: "block_weights",
      currentValue: "all",
      config: {
        label: "Block weights",
        controlAfterGenerate: false,
        valueType: "string",
        sectionId: "advanced_settings",
        groupId: "loader_tuning",
        groupTitle: "Loader tuning",
      },
    };
    return [...widgetInputs, control];
  }

  it("leaves the control where its author put it, even while its slot is hidden", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const inputs = withSidecarControl(widgetInputs);

    const presented = presentLoraStackWidgetInputs(
      inputs,
      STACK_RULES,
      mountedTargets(inputs),
    );

    // Slot 153 is hidden (only 150 shows), but its extra control is not.
    const control = presented.find((widget) => widget.param === "block_weights");
    expect(control?.config).toEqual(inputs.at(-1)?.config);
    expect(presented.at(-1)).toBe(inputs.at(-1));
  });

  it("does not pack the control onto another loader", () => {
    const { widgetInputs } = discover(FOUR_BYPASSED, STACK_RULES);
    const inputs = withSidecarControl(widgetInputs);

    const packed = packLoraStacks({
      widgetInputs: inputs,
      widgetValues: { "153": { lora_name: "b.safetensors", block_weights: "mid" } },
      bypassedWidgetTargets: new Set([key("150"), key("154"), key("155")]),
      rules: STACK_RULES,
    });

    // The LoRA moves to 150; the node-specific control stays on 153.
    expect(packed.widgetValues["150"]?.lora_name).toBe("b.safetensors");
    expect(packed.widgetValues["150"]).not.toHaveProperty("block_weights");
    expect(packed.widgetValues["153"]?.block_weights).toBe("mid");
  });
});

describe("shipped MiniMax i2v LoRA stack", () => {
  const CONFIG_DIR = resolve(
    __dirname,
    "../../../../../../backend/assets/.config",
  );

  /** The panel's widget list for a shipped workflow, as the hook builds it. */
  function shippedWidgets(profile: string) {
    const dir = resolve(CONFIG_DIR, profile);
    const graphData = JSON.parse(
      readFileSync(resolve(dir, "vlo_minimax_h3_i2v.json"), "utf-8"),
    ) as Record<string, unknown>;
    const rules = JSON.parse(
      readFileSync(resolve(dir, "vlo_minimax_h3_i2v.rules.json"), "utf-8"),
    ) as WorkflowRules;
    const widgetInputs = mergeAutodiscoveredLoraWidgetInputs(
      resolveWidgetInputs(null, rules, {
        graphData,
        objectInfo: OBJECT_INFO,
      }),
      resolveAutodiscoveredLoraWidgetInputs(
        buildGenerationNodeCatalogue(null, OBJECT_INFO, graphData),
        new Set([
          ...collectBypassDiscoveryNodeIds(rules),
          ...collectLoraStackNodeIds(rules),
        ]),
      ),
    );
    return { rules, widgetInputs };
  }

  it.each(["default_workflows", "high_vram_workflows"])(
    "reveals %s's four loaders one at a time and packs from the front",
    (profile) => {
      const { rules, widgetInputs } = shippedWidgets(profile);
      const targets = mountedTargets(widgetInputs);

      expect(
        visibleSlots(presentLoraStackWidgetInputs(widgetInputs, rules, targets)),
      ).toEqual([["LoRA 1", "150"]]);

      targets.delete(key("150"));
      expect(
        visibleSlots(presentLoraStackWidgetInputs(widgetInputs, rules, targets)),
      ).toEqual([
        ["LoRA 1", "150"],
        ["LoRA 2", "153"],
      ]);

      // A pick left on the last loader is dispatched through the first.
      const packed = packLoraStacks({
        widgetInputs,
        widgetValues: { "155": { lora_name: "b.safetensors" } },
        bypassedWidgetTargets: new Set([key("150"), key("153"), key("154")]),
        rules,
      });
      expect(packed.widgetValues["150"]?.lora_name).toBe("b.safetensors");
      expect([...packed.bypassedWidgetTargets].sort()).toEqual(
        [key("153"), key("154"), key("155")].sort(),
      );
    },
  );
});
