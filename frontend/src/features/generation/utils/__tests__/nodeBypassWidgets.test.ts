import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import {
  collectDefaultNodeBypassWidgetTargets,
  getNodeBypassWidgetKey,
  isNodeBypassWidgetValue,
  isNodeOrDescendant,
  partitionNodeBypassWidgetInputs,
  reconcileNodeBypassWidgetTargets,
} from "../nodeBypassWidgets";
import { collectWidgetSubmissionState } from "../widgetSubmissionState";
import { buildFrontendStateWidgetKey } from "../../services/frontendRuleState";

const widget: WorkflowWidgetInput = {
  nodeId: "12:6",
  param: "lora_name",
  currentValue: "base.safetensors",
  config: {
    label: "Model",
    controlAfterGenerate: false,
    valueType: "enum",
    options: ["base.safetensors"],
    nodeBypassOption: {
      value: "native:none",
      label: "None (bypass)",
    },
  },
};

describe("node-bypass widget choices", () => {
  it("submits a bypassed scoped node without a widget override candidate", () => {
    expect(isNodeBypassWidgetValue(widget, "native:none")).toBe(true);
    expect(
      partitionNodeBypassWidgetInputs(
        [widget],
        new Set([getNodeBypassWidgetKey("12:6", "lora_name")]),
      ),
    ).toEqual({
      activeWidgetInputs: [],
      bypassNodeIds: ["12:6"],
      activateNodeIds: [],
      inactiveNodeIds: ["12:6"],
    });
    expect(
      partitionNodeBypassWidgetInputs([widget], new Set()),
    ).toEqual({
      activeWidgetInputs: [widget],
      bypassNodeIds: [],
      activateNodeIds: [],
      inactiveNodeIds: [],
    });
  });

  it("inverts the effect for a loader the workflow ships bypassed", () => {
    const shippedBypassed: WorkflowWidgetInput = {
      ...widget,
      config: { ...widget.config, nodeShipsBypassed: true },
    };

    // Left on the bypass choice: the node is already off in the file, so the
    // submission has nothing to say about it.
    expect(
      partitionNodeBypassWidgetInputs(
        [shippedBypassed],
        new Set([getNodeBypassWidgetKey("12:6", "lora_name")]),
      ),
    ).toEqual({
      activeWidgetInputs: [],
      bypassNodeIds: [],
      activateNodeIds: [],
      inactiveNodeIds: ["12:6"],
    });

    expect(
      partitionNodeBypassWidgetInputs([shippedBypassed], new Set()),
    ).toEqual({
      activeWidgetInputs: [shippedBypassed],
      bypassNodeIds: [],
      activateNodeIds: ["12:6"],
      inactiveNodeIds: [],
    });
  });

  it("ignores stale selections after a widget stops supporting bypass", () => {
    const fixedWidget: WorkflowWidgetInput = {
      ...widget,
      config: {
        ...widget.config,
        nodeBypassOption: undefined,
      },
    };

    expect(
      partitionNodeBypassWidgetInputs(
        [fixedWidget],
        new Set([getNodeBypassWidgetKey("12:6", "lora_name")]),
      ),
    ).toEqual({
      activeWidgetInputs: [fixedWidget],
      bypassNodeIds: [],
      activateNodeIds: [],
      inactiveNodeIds: [],
    });
  });
});

describe("isNodeOrDescendant", () => {
  it("matches the node and ids scoped under it, not lookalike ids", () => {
    expect(isNodeOrDescendant("20", "20")).toBe(true);
    expect(isNodeOrDescendant("20:30", "20")).toBe(true);
    expect(isNodeOrDescendant("20:30:40", "20:30")).toBe(true);
    expect(isNodeOrDescendant("200", "20")).toBe(false);
    expect(isNodeOrDescendant("200:30", "20")).toBe(false);
    expect(isNodeOrDescendant("2:20", "20")).toBe(false);
    expect(isNodeOrDescendant("20", "20:30")).toBe(false);
  });
});

describe("widget submission for bypassed nodes", () => {
  const strength: WorkflowWidgetInput = {
    nodeId: "12:6",
    param: "strength_model",
    currentValue: 1,
    config: {
      label: "Strength",
      controlAfterGenerate: false,
      valueType: "float",
    },
  };
  const seed: WorkflowWidgetInput = {
    nodeId: "3",
    param: "seed",
    currentValue: 7,
    config: { label: "Seed", controlAfterGenerate: true, valueType: "int" },
  };

  it.each([
    ["bypasses", widget],
    [
      "leaves off as shipped",
      { ...widget, config: { ...widget.config, nodeShipsBypassed: true } },
    ],
  ])(
    "sends no overrides for the other widgets of a node it %s",
    (_label, loader) => {
      const submission = collectWidgetSubmissionState({
        widgetInputs: [loader, strength, seed],
        widgetValues: {},
        randomizeToggles: {},
        bypassedWidgetTargets: new Set([
          getNodeBypassWidgetKey("12:6", "lora_name"),
        ]),
      });

      expect(submission.widgetOverrides).toEqual({ widget_3_seed: "7" });
      // Still saved with the panel, so turning the loader back on restores it.
      expect(submission.frontendStateWidgetValues).toMatchObject({
        [buildFrontendStateWidgetKey("12:6", "strength_model")]: 1,
      });
    },
  );

  it("sends no overrides for nodes inside a subgraph it bypasses", () => {
    const instance: WorkflowWidgetInput = { ...widget, nodeId: "20" };
    const inner = (nodeId: string): WorkflowWidgetInput => ({
      ...strength,
      nodeId,
    });

    const submission = collectWidgetSubmissionState({
      widgetInputs: [instance, inner("20:30:40"), inner("200:30"), seed],
      widgetValues: {},
      randomizeToggles: {},
      bypassedWidgetTargets: new Set([
        getNodeBypassWidgetKey("20", "lora_name"),
      ]),
    });

    expect(submission.widgetOverrides).toEqual({
      "widget_200:30_strength_model": "1",
      widget_3_seed: "7",
    });
  });

  it("still sends a loader's widgets while it runs", () => {
    const submission = collectWidgetSubmissionState({
      widgetInputs: [widget, strength],
      widgetValues: {},
      randomizeToggles: {},
      bypassedWidgetTargets: new Set(),
    });

    expect(submission.widgetOverrides).toEqual({
      "widget_12:6_lora_name": "base.safetensors",
      "widget_12:6_strength_model": "1",
    });
  });
});

function bypassableWidget(
  nodeId: string,
  overrides: Partial<WorkflowWidgetInput["config"]> = {},
): WorkflowWidgetInput {
  return {
    ...widget,
    nodeId,
    config: { ...widget.config, ...overrides },
  };
}

describe("reconcileNodeBypassWidgetTargets", () => {
  it("starts a rule-defaulted loader bypassed", () => {
    const defaulted = bypassableWidget("7", { defaultNodeBypass: true });
    const plain = bypassableWidget("8");

    const result = reconcileNodeBypassWidgetTargets({
      widgetInputs: [defaulted, plain],
      previousTargets: new Set(),
      appliedDefaults: new Set(),
    });

    expect(result.changed).toBe(true);
    expect([...result.targets]).toEqual([
      getNodeBypassWidgetKey("7", "lora_name"),
    ]);
    expect([...result.appliedDefaults]).toEqual([
      getNodeBypassWidgetKey("7", "lora_name"),
    ]);
  });

  it("never re-applies a default the user has turned back on", () => {
    const defaulted = bypassableWidget("7", { defaultNodeBypass: true });
    const applied = new Set([getNodeBypassWidgetKey("7", "lora_name")]);

    const result = reconcileNodeBypassWidgetTargets({
      widgetInputs: [defaulted],
      previousTargets: new Set(),
      appliedDefaults: applied,
    });

    expect(result.changed).toBe(false);
    expect([...result.targets]).toEqual([]);
    expect(result.appliedDefaults).toBe(applied);
  });

  it("drops selections whose widget stopped offering a bypass choice", () => {
    const fixed = bypassableWidget("7", { nodeBypassOption: undefined });

    const result = reconcileNodeBypassWidgetTargets({
      widgetInputs: [fixed],
      previousTargets: new Set([getNodeBypassWidgetKey("7", "lora_name")]),
      appliedDefaults: new Set(),
    });

    expect(result.changed).toBe(true);
    expect([...result.targets]).toEqual([]);
  });

  it("ignores the default flag on a widget with no bypass choice", () => {
    const result = reconcileNodeBypassWidgetTargets({
      widgetInputs: [
        bypassableWidget("7", {
          nodeBypassOption: undefined,
          defaultNodeBypass: true,
        }),
      ],
      previousTargets: new Set(),
      appliedDefaults: new Set(),
    });

    expect(result.changed).toBe(false);
    expect([...result.targets]).toEqual([]);
    expect([...result.appliedDefaults]).toEqual([]);
  });

  it("keeps an untouched selection stable across a widget-list identity flip", () => {
    const defaulted = bypassableWidget("7", { defaultNodeBypass: true });
    const first = reconcileNodeBypassWidgetTargets({
      widgetInputs: [defaulted],
      previousTargets: new Set(),
      appliedDefaults: new Set(),
    });

    const second = reconcileNodeBypassWidgetTargets({
      widgetInputs: [bypassableWidget("7", { defaultNodeBypass: true })],
      previousTargets: first.targets,
      appliedDefaults: first.appliedDefaults,
    });

    expect(second.changed).toBe(false);
    expect(second.targets).toBe(first.targets);
  });

  it("collects the rule-defaulted targets a replay must not re-default", () => {
    expect([
      ...collectDefaultNodeBypassWidgetTargets([
        bypassableWidget("7", { defaultNodeBypass: true }),
        bypassableWidget("8"),
      ]),
    ]).toEqual([getNodeBypassWidgetKey("7", "lora_name")]);
  });
});

describe("reconcileNodeBypassWidgetTargets while widgets are absent", () => {
  it("keeps selections and does not re-apply defaults when preserving", () => {
    const key = getNodeBypassWidgetKey("12:6", "lora_name");
    const absent = reconcileNodeBypassWidgetTargets({
      widgetInputs: [],
      previousTargets: new Set([key]),
      appliedDefaults: new Set([key]),
      preserveMissing: true,
    });
    expect([...absent.targets]).toEqual([key]);
    expect(absent.changed).toBe(false);

    const dropped = reconcileNodeBypassWidgetTargets({
      widgetInputs: [],
      previousTargets: new Set([key]),
      appliedDefaults: new Set([key]),
    });
    expect([...dropped.targets]).toEqual([]);
  });
});

describe("reconcileNodeBypassWidgetTargets following ComfyUI mode changes", () => {
  const key = getNodeBypassWidgetKey("7", "lora_name");
  const shippedBypassed = () =>
    bypassableWidget("7", { nodeShipsBypassed: true, defaultNodeBypass: true });
  const shippedActive = () => bypassableWidget("7");

  function mount(initial: WorkflowWidgetInput) {
    return reconcileNodeBypassWidgetTargets({
      widgetInputs: [initial],
      previousTargets: new Set(),
      appliedDefaults: new Set(),
      previousShippedBypass: new Map(),
    });
  }

  it("turns a loader on when it is unbypassed in the editor", () => {
    const first = mount(shippedBypassed());
    expect([...first.targets]).toEqual([key]);

    const second = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedActive()],
      previousTargets: first.targets,
      appliedDefaults: first.appliedDefaults,
      previousShippedBypass: first.shippedBypass,
    });

    expect(second.changed).toBe(true);
    expect([...second.targets]).toEqual([]);
  });

  it("switches a loader off when it is bypassed in the editor", () => {
    const first = mount(shippedActive());
    expect([...first.targets]).toEqual([]);

    const second = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedBypassed()],
      previousTargets: first.targets,
      appliedDefaults: first.appliedDefaults,
      previousShippedBypass: first.shippedBypass,
    });

    expect([...second.targets]).toEqual([key]);
    // The flip stands in for the default, which must not be applied later.
    expect(second.appliedDefaults.has(key)).toBe(true);
  });

  it("keeps a panel choice while the node's mode is unchanged", () => {
    const first = mount(shippedBypassed());
    // The user picks a model in the panel: the target is cleared.
    const second = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedBypassed()],
      previousTargets: new Set(),
      appliedDefaults: first.appliedDefaults,
      previousShippedBypass: first.shippedBypass,
    });

    expect(second.changed).toBe(false);
    expect([...second.targets]).toEqual([]);
  });

  it("takes the workflow's state for a loader that drops out and returns", () => {
    const first = mount(shippedBypassed());
    const chosen = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedBypassed()],
      previousTargets: new Set(),
      appliedDefaults: first.appliedDefaults,
      previousShippedBypass: first.shippedBypass,
    });
    // Muted in the editor: the widget disappears with its selection.
    const muted = reconcileNodeBypassWidgetTargets({
      widgetInputs: [],
      previousTargets: chosen.targets,
      appliedDefaults: chosen.appliedDefaults,
      previousShippedBypass: chosen.shippedBypass,
    });
    // Back to bypassed: it must not come back switched on.
    const returned = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedBypassed()],
      previousTargets: muted.targets,
      appliedDefaults: muted.appliedDefaults,
      previousShippedBypass: muted.shippedBypass,
    });

    expect([...returned.targets]).toEqual([key]);
  });

  it("remembers modes through a same-workflow reload", () => {
    const first = mount(shippedBypassed());
    const reloading = reconcileNodeBypassWidgetTargets({
      widgetInputs: [],
      previousTargets: new Set(),
      appliedDefaults: first.appliedDefaults,
      previousShippedBypass: first.shippedBypass,
      preserveMissing: true,
    });
    const reloaded = reconcileNodeBypassWidgetTargets({
      widgetInputs: [shippedBypassed()],
      previousTargets: reloading.targets,
      appliedDefaults: reloading.appliedDefaults,
      previousShippedBypass: reloading.shippedBypass,
    });

    // The model the user picked before the reload survives it.
    expect([...reloaded.targets]).toEqual([]);
  });
});
