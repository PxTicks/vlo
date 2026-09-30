import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationPanel } from "../useGenerationPanel";
import { useGenerationStore } from "../../useGenerationStore";
import { resetZustandStore } from "../../../../testUtils/zustand";
import { createDefaultWorkflowRules } from "../../services/workflowRules";
import { LORA_BYPASS_CHOICE } from "../../utils/loraLoaderWidgets";
import type { WorkflowWidgetInput } from "../../types";

const OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [["a.safetensors", "b.safetensors", "c.safetensors"], {}],
        strength_model: ["FLOAT", { default: 1 }],
      },
    },
    input_order: { required: ["model", "lora_name", "strength_model"] },
  },
};

const RULES = createDefaultWorkflowRules({
  lora_stacks: [{ id: "model", nodes: ["150", "153", "154"] }],
});

/** The editor graph: every stack member bypassed unless `modes` says not. */
function graph(modes: Record<number, number> = {}) {
  return {
    nodes: [150, 153, 154].map((id) => ({
      id,
      type: "LoraLoaderModelOnly",
      mode: modes[id] ?? 4,
      widgets_values: ["a.safetensors", 1],
    })),
  };
}

function mountPanel() {
  useGenerationStore.setState({
    selectedWorkflowId: "wf.json",
    activeWorkflowRules: RULES,
    // Bypassed nodes are pruned from the API prompt; the graph carries them.
    syncedWorkflow: {},
    syncedGraphData: graph(),
    rawObjectInfo: OBJECT_INFO,
    connectionStatus: "connected",
  });
  return renderHook(() => useGenerationPanel());
}

function visibleSlots(presented: readonly WorkflowWidgetInput[]) {
  return presented
    .filter(
      (widget) => widget.param === "lora_name" && widget.config.hidden !== true,
    )
    .map((widget) => `${widget.config.groupTitle}=${widget.nodeId}`);
}

beforeEach(() => {
  resetZustandStore(useGenerationStore);
  vi.spyOn(useGenerationStore.getState(), "connect").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetZustandStore(useGenerationStore);
});

describe("useGenerationPanel LoRA stacks", () => {
  it("grows the list as LoRAs are picked and closes the gap when one is cleared", () => {
    const hook = mountPanel();
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=150",
    ]);

    act(() => {
      hook.result.current.handleWidgetChange("150", "lora_name", "b.safetensors");
    });
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=150",
      "LoRA 2=153",
    ]);

    act(() => {
      hook.result.current.handleWidgetChange("153", "lora_name", "c.safetensors");
    });
    act(() => {
      hook.result.current.handleWidgetBypassChoice(
        "150",
        "lora_name",
        LORA_BYPASS_CHOICE,
      );
    });
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=153",
      "LoRA 2=150",
    ]);
    // The panel's own state is per node: nothing moved.
    expect(hook.result.current.widgetValues["153"]?.lora_name).toBe(
      "c.safetensors",
    );
  });

  it("packs the selected LoRAs into the leading loaders on submission", async () => {
    const queueGeneration = vi.fn(async () => {});
    useGenerationStore.setState({ queueGeneration });
    const hook = mountPanel();

    act(() => {
      hook.result.current.handleWidgetChange("154", "lora_name", "c.safetensors");
    });
    await act(async () => {
      await hook.result.current.handleGenerate();
    });

    expect(queueGeneration).toHaveBeenCalledTimes(1);
    const [, overrides, , , , , bypassNodeIds, activateNodeIds] =
      queueGeneration.mock.calls[0] as unknown as [
        unknown,
        Record<string, string>,
        unknown,
        unknown,
        unknown,
        unknown,
        string[],
        string[],
      ];
    expect(overrides.widget_150_lora_name).toBe("c.safetensors");
    expect(overrides).not.toHaveProperty("widget_154_lora_name");
    expect(activateNodeIds).toEqual(["150"]);
    expect(bypassNodeIds).toEqual([]);
    // The panel keeps showing the pick where the user made it.
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=154",
      "LoRA 2=150",
    ]);
  });

  it("follows a loader turned on or bypassed inside ComfyUI", () => {
    const hook = mountPanel();

    act(() => {
      useGenerationStore.setState({ syncedGraphData: graph({ 153: 0 }) });
    });
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=153",
      "LoRA 2=150",
    ]);
    expect(hook.result.current.bypassedWidgetTargets.size).toBe(2);

    act(() => {
      useGenerationStore.setState({ syncedGraphData: graph() });
    });
    expect(visibleSlots(hook.result.current.presentedWidgetInputs)).toEqual([
      "LoRA 1=150",
    ]);
  });
});
