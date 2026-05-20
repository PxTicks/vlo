import { describe, expect, it } from "vitest";
import type { WorkflowReplayPanelState } from "../../store/types";
import type { WorkflowInput, WorkflowWidgetInput } from "../../types";
import {
  areWidgetValueMapsEqual,
  hydrateReplayRandomizeToggles,
  hydrateReplayTextValues,
  resolveReplayWidgetValues,
  shouldWaitForReplayPanelHydration,
} from "../replayPanelHydration";

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
