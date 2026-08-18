import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import {
  collectDefaultNodeBypassWidgetTargets,
  getNodeBypassWidgetKey,
  isNodeBypassWidgetValue,
  partitionNodeBypassWidgetInputs,
  reconcileNodeBypassWidgetTargets,
} from "../nodeBypassWidgets";

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
    });
    expect(
      partitionNodeBypassWidgetInputs([widget], new Set()),
    ).toEqual({
      activeWidgetInputs: [widget],
      bypassNodeIds: [],
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
