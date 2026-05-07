import { describe, expect, it } from "vitest";

import { createDefaultWorkflowRules } from "../workflowRules";
import {
  evaluateEffectSwitchesForState,
  evaluateRewrites,
  evaluateWidgetDefaultOverrides,
} from "../evaluateRewrites";
import {
  buildFrontendStateControlKey,
  buildFrontendStateDerivedWidgetKey,
  createFrontendRuleState,
  evaluateFrontendStateCondition,
} from "../frontendRuleState";

function createSelectionMetadata(
  overrides: Partial<{ durationSeconds: number }> = {},
) {
  const durationSeconds = overrides.durationSeconds ?? 6;
  return {
    startTick: 0,
    endTick: durationSeconds * 1000,
    durationTicks: durationSeconds * 1000,
    durationSeconds,
    effectiveFps: 24,
    frameStep: 1,
    frameCount: durationSeconds * 24,
    clipCount: 1,
    trackCount: 1,
    includedTrackCount: 1,
    hasMaskClip: false,
    isRange: true,
  };
}

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
                    kind: "compare",
                    ref: {
                      kind: "frontend_control",
                      control_id: "prompt_enhancer_enabled",
                    },
                    operator: "eq",
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
            kind: "compare",
            ref: {
              kind: "frontend_control",
              control_id: "prompt_enhancer_enabled",
            },
            operator: "eq",
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

  it("can rewrite workflow widgets from a frontend control", () => {
    const rules = createDefaultWorkflowRules({
      rewrites: [
        {
          when: {
            kind: "compare",
            ref: {
              kind: "frontend_control",
              control_id: "prompt_enhancer_enabled",
            },
            operator: "eq",
            value: false,
          },
          set_widgets: [
            {
              node_id: "594",
              widget: "value",
              value: false,
            },
          ],
        },
      ],
    });

    expect(
      evaluateRewrites(rules.rewrites ?? [], new Set(), {
        [buildFrontendStateControlKey("prompt_enhancer_enabled")]: false,
      }),
    ).toEqual({
      bypass: [],
      widgetOverrides: [
        { node_id: "594", widget: "value", value: false },
      ],
    });
  });

  it("can bypass nodes from timeline selection metadata", () => {
    const rules = createDefaultWorkflowRules({
      rewrites: [
        {
          when: {
            kind: "compare",
            ref: {
              kind: "input_metadata",
              input: "89",
              field: "timelineSelection.durationSeconds",
            },
            operator: "gt",
            value: 5,
          },
          bypass: ["347"],
        },
      ],
    });

    expect(
      evaluateRewrites(
        rules.rewrites ?? [],
        new Set(["89"]),
        {},
        {
          "89": {
            sourceKind: "timeline_selection",
            inputType: "video",
            mediaType: "video",
            timelineSelection: createSelectionMetadata(),
          },
        },
      ),
    ).toEqual({
      bypass: ["347"],
      widgetOverrides: [],
    });
  });
});

describe("evaluateEffectSwitchesForState", () => {
  it("uses the first matching case for each switch", () => {
    const rules = createDefaultWorkflowRules({
      effect_switches: [
        {
          id: "prompt_enhancer",
          cases: [
            {
              when: {
                kind: "compare",
                ref: {
                  kind: "frontend_control",
                  control_id: "prompt_enhancer_enabled",
                },
                operator: "eq",
                value: false,
              },
              bypass: ["347"],
              set_widgets: [
                { node_id: "594", widget: "value", value: false },
              ],
            },
            {
              when: { kind: "always" },
              bypass: ["348"],
              set_widgets: [
                { node_id: "594", widget: "value", value: true },
              ],
            },
          ],
        },
      ],
    });

    expect(
      evaluateEffectSwitchesForState(
        rules.effect_switches ?? [],
        new Set(),
        { [buildFrontendStateControlKey("prompt_enhancer_enabled")]: false },
      ),
    ).toEqual({
      bypass: ["347"],
      widgetOverrides: [
        { node_id: "594", widget: "value", value: false },
      ],
    });
  });

  it("falls through to an always catch-all when no earlier case matches", () => {
    const rules = createDefaultWorkflowRules({
      effect_switches: [
        {
          cases: [
            {
              when: {
                kind: "compare",
                ref: {
                  kind: "frontend_control",
                  control_id: "prompt_enhancer_enabled",
                },
                operator: "eq",
                value: false,
              },
              bypass: ["347"],
            },
            {
              when: { kind: "always" },
              set_widgets: [
                { node_id: "594", widget: "value", value: true },
              ],
            },
          ],
        },
      ],
    });

    expect(
      evaluateEffectSwitchesForState(
        rules.effect_switches ?? [],
        new Set(),
        { [buildFrontendStateControlKey("prompt_enhancer_enabled")]: true },
      ),
    ).toEqual({
      bypass: [],
      widgetOverrides: [
        { node_id: "594", widget: "value", value: true },
      ],
    });
  });

  it("compares derived widget values with equality and numeric operators", () => {
    const rules = createDefaultWorkflowRules({
      effect_switches: [
        {
          id: "denoise_is_one",
          cases: [
            {
              when: {
                kind: "compare",
                ref: {
                  kind: "derived_widget",
                  derived_widget_id: "single_sampler_denoise",
                },
                operator: "eq",
                value: 1,
              },
              bypass: ["113", "114"],
            },
          ],
        },
        {
          id: "denoise_partial",
          cases: [
            {
              when: {
                kind: "compare",
                ref: {
                  kind: "derived_widget",
                  derived_widget_id: "single_sampler_denoise",
                },
                operator: "lt",
                value: 1,
              },
              set_widgets: [
                { node_id: "114", widget: "value", value: true },
              ],
            },
          ],
        },
      ],
    });

    expect(
      evaluateEffectSwitchesForState(
        rules.effect_switches ?? [],
        new Set(),
        { [buildFrontendStateDerivedWidgetKey("single_sampler_denoise")]: "0.5" },
      ),
    ).toEqual({
      bypass: [],
      widgetOverrides: [
        { node_id: "114", widget: "value", value: true },
      ],
    });

    expect(
      evaluateEffectSwitchesForState(
        rules.effect_switches ?? [],
        new Set(),
        { [buildFrontendStateDerivedWidgetKey("single_sampler_denoise")]: 1 },
      ),
    ).toEqual({
      bypass: ["113", "114"],
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
          kind: "compare",
          ref: {
            kind: "frontend_control",
            control_id: "prompt_enhancer_enabled",
          },
          operator: "eq",
          value: true,
        },
        state,
      ),
    ).toBe(true);
  });

  it("keeps input_presence behavior unchanged", () => {
    const state = createFrontendRuleState(new Set(["167"]), {});

    expect(
      evaluateFrontendStateCondition(
        {
          kind: "input_presence",
          inputs: ["167"],
          match: "all_present",
        },
        state,
      ),
    ).toBe(true);
    expect(
      evaluateFrontendStateCondition(
        {
          kind: "input_presence",
          inputs: ["167"],
          match: "all_missing",
        },
        state,
      ),
    ).toBe(false);
  });

  it("resolves input metadata references from the state bag", () => {
    const state = createFrontendRuleState(
      new Set(["89"]),
      {},
      {
        "89": {
          sourceKind: "timeline_selection",
          inputType: "video",
          mediaType: "video",
          timelineSelection: createSelectionMetadata({ durationSeconds: 3 }),
        },
      },
    );

    expect(
      evaluateFrontendStateCondition(
        {
          kind: "compare",
          ref: {
            kind: "input_metadata",
            input: "89",
            field: "timelineSelection.durationSeconds",
          },
          operator: "eq",
          value: 3,
        },
        state,
      ),
    ).toBe(true);
  });
});
