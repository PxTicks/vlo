import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import {
  getNodeBypassWidgetKey,
  isNodeBypassWidgetValue,
  partitionNodeBypassWidgetInputs,
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
