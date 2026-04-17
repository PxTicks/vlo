import { describe, expect, it } from "vitest";

import { createDefaultWorkflowRules } from "../workflowRules";
import {
  evaluateRewrites,
  evaluateWidgetDefaultOverrides,
} from "../evaluateRewrites";
import {
  buildFrontendStateControlKey,
  createFrontendRuleState,
  evaluateFrontendStateCondition,
} from "../frontendRuleState";

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
      },
    });

    expect(evaluateWidgetDefaultOverrides(rules, new Set())).toEqual([
      { node_id: "290", widget: "value", value: true },
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

  it("can drive widget defaults from a frontend boolean widget", () => {
    const rules = createDefaultWorkflowRules({
      frontend_controls: {
        prompt_enhancer_enabled: {
          value_type: "boolean",
          default: true,
        },
      },
      nodes: {
        "349": {
          widgets: {
            sampling_mode: {
              value_type: "boolean",
              default_overrides: [
                {
                  when: {
                    kind: "frontend_control_boolean",
                    control_id: "prompt_enhancer_enabled",
                    value: true,
                  },
                  value: "on",
                },
              ],
            },
          },
        },
      },
    });

    expect(
      evaluateWidgetDefaultOverrides(
        rules,
        new Set(),
        { [buildFrontendStateControlKey("prompt_enhancer_enabled")]: true },
      ),
    ).toEqual([
      { node_id: "349", widget: "sampling_mode", value: "on" },
    ]);
  });
});

describe("evaluateRewrites", () => {
  it("bypasses the prompt enhancer branch when the toggle is off", () => {
    const rules = createDefaultWorkflowRules({
      rewrites: [
        {
          when: {
            kind: "frontend_control_boolean",
            control_id: "prompt_enhancer_enabled",
            value: false,
          },
          bypass: ["347", "348", "349", "350"],
        },
      ],
    });

    expect(
      evaluateRewrites(rules.rewrites ?? [], new Set(), {
        [buildFrontendStateControlKey("prompt_enhancer_enabled")]: false,
      }),
    ).toEqual({
      bypass: ["347", "348", "349", "350"],
      widgetOverrides: [],
    });
  });
});

describe("evaluateFrontendStateCondition", () => {
  it("treats string-backed frontend control state as booleans", () => {
    const state = createFrontendRuleState(new Set(), {
      [buildFrontendStateControlKey("prompt_enhancer_enabled")]: "true",
    });

    expect(
      evaluateFrontendStateCondition(
        {
          kind: "frontend_control_boolean",
          control_id: "prompt_enhancer_enabled",
          value: true,
        },
        state,
      ),
    ).toBe(true);
  });
});
