import { describe, expect, it } from "vitest";

import { createDefaultWorkflowRules } from "../workflowRules";
import { evaluateWidgetDefaultOverrides } from "../evaluateRewrites";

const IMAGE_PRESENCE_OVERRIDES = [
  {
    when: {
      kind: "input_presence" as const,
      inputs: ["167"],
      match: "all_missing" as const,
    },
    value: true,
  },
  {
    when: {
      kind: "input_presence" as const,
      inputs: ["167"],
      match: "all_present" as const,
    },
    value: false,
  },
];

describe("evaluateWidgetDefaultOverrides", () => {
  it("enables t2v-oriented defaults when the source image is missing", () => {
    const rules = createDefaultWorkflowRules({
      nodes: {
        "290": {
          widgets: {
            value: {
              value_type: "boolean",
              default_overrides: IMAGE_PRESENCE_OVERRIDES,
            },
          },
        },
        "349": {
          widgets: {
            sampling_mode: {
              value_type: "boolean",
              default_overrides: [
                {
                  when: {
                    kind: "input_presence",
                    inputs: ["167"],
                    match: "all_missing",
                  },
                  value: "on",
                },
                {
                  when: {
                    kind: "input_presence",
                    inputs: ["167"],
                    match: "all_present",
                  },
                  value: "off",
                },
              ],
            },
          },
        },
      },
    });

    expect(evaluateWidgetDefaultOverrides(rules, new Set())).toEqual([
      { node_id: "290", widget: "value", value: true },
      { node_id: "349", widget: "sampling_mode", value: "on" },
    ]);
  });

  it("restores i2v defaults when the source image is present", () => {
    const rules = createDefaultWorkflowRules({
      nodes: {
        "290": {
          widgets: {
            value: {
              value_type: "boolean",
              default_overrides: IMAGE_PRESENCE_OVERRIDES,
            },
          },
        },
      },
    });

    expect(evaluateWidgetDefaultOverrides(rules, new Set(["167"]))).toEqual([
      { node_id: "290", widget: "value", value: false },
    ]);
  });
});
