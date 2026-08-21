import { describe, expect, it } from "vitest";
import type { WorkflowReplayPanelState } from "../../store/types";
import type { WorkflowInput, WorkflowWidgetInput } from "../../types";
import {
  areWidgetValueMapsEqual,
  hydrateReplayRandomizeToggles,
  hydrateReplayTextValues,
  resolveReplayNodeBypassWidgetTargets,
  resolveReplayWidgetValues,
  shouldWaitForReplayPanelHydration,
} from "../replayPanelHydration";
import { getNodeBypassWidgetKey } from "../nodeBypassWidgets";

const EMPTY_REPLAY_STATE: WorkflowReplayPanelState = {
  textValues: {},
  widgetValues: {},
  widgetModes: {},
  derivedWidgetValues: {},
};

function makeTextInput(): WorkflowInput {
  return {
    id: "6:text",
    nodeId: "6",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "rule",
  };
}

function makeSeedWidget(): WorkflowWidgetInput {
  return {
    nodeId: "145",
    param: "seed",
    config: {
      label: "Seed",
      controlAfterGenerate: true,
      valueType: "int",
    },
    currentValue: 11,
  };
}

function makeLoraWidget(): WorkflowWidgetInput {
  return {
    nodeId: "12:6",
    param: "lora_name",
    config: {
      label: "Model",
      controlAfterGenerate: false,
      valueType: "enum",
      options: ["base.safetensors"],
      nodeBypassOption: {
        value: "vlo.lora-loader:none",
        label: "None (bypass)",
      },
    },
    currentValue: "base.safetensors",
  };
}

describe("replayPanelHydration", () => {
  it("waits for widget inputs while replay hydration is still loading", () => {
    const replayState: WorkflowReplayPanelState = {
      ...EMPTY_REPLAY_STATE,
      widgetValues: {
        widget_145_seed: "18446744073709551615",
      },
    };

    expect(
      shouldWaitForReplayPanelHydration(replayState, [], [], true),
    ).toBe(true);
    expect(
      shouldWaitForReplayPanelHydration(
        replayState,
        [],
        [makeSeedWidget()],
        true,
      ),
    ).toBe(false);
    expect(
      shouldWaitForReplayPanelHydration(replayState, [], [], false),
    ).toBe(false);
  });

  it("restores unsafe integer seed widgets as strings and their randomize mode", () => {
    const replayState: WorkflowReplayPanelState = {
      ...EMPTY_REPLAY_STATE,
      widgetValues: {
        widget_145_seed: "18446744073709551615",
      },
      widgetModes: {
        widget_mode_145_seed: "randomize",
      },
    };

    expect(resolveReplayWidgetValues(replayState, [makeSeedWidget()])).toEqual({
      "145": {
        seed: "18446744073709551615",
      },
    });

    const toggles = hydrateReplayRandomizeToggles(
      { "145:seed": false },
      replayState,
      [makeSeedWidget()],
    );

    expect(toggles).toEqual({
      value: { "145:seed": true },
      changed: true,
    });
  });

  it("restores and clears native node bypasses from replay state", () => {
    const replayState: WorkflowReplayPanelState = {
      ...EMPTY_REPLAY_STATE,
      bypassNodeIds: ["12:6"],
    };
    const widget = makeLoraWidget();

    expect(
      shouldWaitForReplayPanelHydration(replayState, [], [], true),
    ).toBe(true);
    expect(resolveReplayNodeBypassWidgetTargets(replayState, [widget])).toEqual(
      new Set([getNodeBypassWidgetKey("12:6", "lora_name")]),
    );
    expect(
      resolveReplayNodeBypassWidgetTargets(EMPTY_REPLAY_STATE, [widget]),
    ).toEqual(new Set());
  });

  it("reads a loader that ships bypassed from the recorded activation", () => {
    const widget = makeLoraWidget();
    const shippedBypassed: WorkflowWidgetInput = {
      ...widget,
      config: { ...widget.config, nodeShipsBypassed: true },
    };
    const key = getNodeBypassWidgetKey("12:6", "lora_name");

    // Nothing recorded: the generation ran with the loader off, because that
    // is what a node shipping bypassed and contributing no effect means.
    expect(
      resolveReplayNodeBypassWidgetTargets(EMPTY_REPLAY_STATE, [
        shippedBypassed,
      ]),
    ).toEqual(new Set([key]));

    expect(
      resolveReplayNodeBypassWidgetTargets(
        { ...EMPTY_REPLAY_STATE, activateNodeIds: ["12:6"] },
        [shippedBypassed],
      ),
    ).toEqual(new Set());

    // Both lists cannot come from a submission, so this is merged or edited
    // metadata; replay follows the same precedence the runtime does.
    expect(
      resolveReplayNodeBypassWidgetTargets(
        {
          ...EMPTY_REPLAY_STATE,
          bypassNodeIds: ["12:6"],
          activateNodeIds: ["12:6"],
        },
        [shippedBypassed],
      ),
    ).toEqual(new Set([key]));
  });

  it("keeps text state identity when replayed text is already applied", () => {
    const previous = { "6:text": "same prompt" };
    const replayState: WorkflowReplayPanelState = {
      ...EMPTY_REPLAY_STATE,
      textValues: {
        "6:text": "same prompt",
      },
    };

    const result = hydrateReplayTextValues(previous, replayState, [
      makeTextInput(),
    ]);

    expect(result.value).toBe(previous);
    expect(result.changed).toBe(false);
  });

  it("compares widget value maps by value", () => {
    expect(
      areWidgetValueMapsEqual(
        { "145": { seed: "18446744073709551615" } },
        { "145": { seed: "18446744073709551615" } },
      ),
    ).toBe(true);
    expect(
      areWidgetValueMapsEqual(
        { "145": { seed: "18446744073709551615" } },
        { "145": { seed: "11" } },
      ),
    ).toBe(false);
  });
});
