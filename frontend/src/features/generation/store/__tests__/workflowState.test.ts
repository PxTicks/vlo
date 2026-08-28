import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowRules } from "../../services/workflowRules";
import {
  EMPTY_WORKFLOW_RULES,
  PRUNED_WORKFLOW_RULE_SECTIONS,
  applyPresentationRules,
  areWorkflowRulesCompatibleWithWorkflow,
  areWorkflowRulesEffectivelyEmpty,
  findLostRuleFragments,
  hasApplicableWorkflowRules,
  hasNodeLinkedWorkflowRules,
  haveSubstantialWorkflowOverlap,
  pruneWorkflowRulesForWorkflows,
  resolveWidgetInputs,
} from "../workflowState";

function workflow(
  nodes: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, classType]) => [
      id,
      { class_type: classType, inputs: {} },
    ]),
  );
}

function rulesFixture(): WorkflowRules {
  return {
    version: 1,
    name: "Fixture",
    default_widgets_mode: "manual",
    nodes: {
      "1": {
        present: {
          label: "Primary",
          control_id: "control-keep",
        },
        widgets: {
          seed: {
            default: 1,
            default_overrides: [
              { when: { node_id: "1" }, value: 2 },
              { when: { node_id: "missing" }, value: 3 },
            ],
          },
        },
        ignore_overrides: [
          { when: { input: "2:image" }, value: true },
          { when: { input: "missing:image" }, value: true },
        ],
      },
      missing: {
        present: { label: "Stale" },
      },
    },
    validation: {
      inputs: [
        { kind: "required", input: "1" },
        { kind: "optional", input: "missing" },
        {
          kind: "at_least_n",
          inputs: ["1:image", "2:image", "2:image", "missing:image"],
          min: 9,
        },
        { kind: "at_least_n", inputs: ["missing"], min: 1 },
      ],
    },
    input_conditions: [
      { kind: "at_least_one", inputs: ["1", "missing"] },
      { kind: "at_least_one", inputs: ["missing"] },
    ],
    frontend_controls: {
      "control-keep": {
        label: "Keep",
        default_overrides: [
          { when: { node_id: "2" }, value: 5 },
          { when: { node_id: "missing" }, value: 6 },
        ],
      },
      "control-drop": { label: "Drop" },
    },
    derived_widgets: [
      {
        id: "derived-keep",
        kind: "dual_sampler_denoise",
        control_id: "control-keep",
        sampler_node_ids: ["1", "2"],
        split_step_targets: [
          { node_id: "1", param: "steps" },
          { node_id: "missing", param: "steps" },
        ],
      },
      {
        id: "derived-drop",
        kind: "dual_sampler_denoise",
        sampler_node_ids: ["missing"],
      },
    ],
    rewrites: [
      { kind: "set_input", node_id: "1", input: "seed", value: 4 },
      { kind: "set_input", node_id: "missing", input: "seed", value: 5 },
    ],
    effect_switches: [
      {
        id: "switch-keep",
        cases: [
          {
            when: {
              kind: "compare",
              ref: { kind: "workflow_param", node_id: "1", param: "denoise" },
              operator: "lt",
              value: 1,
            },
            set_widgets: [{ node_id: "2", widget: "switch", value: false }],
          },
          {
            when: { kind: "always" },
            set_widgets: [
              { node_id: "missing", widget: "switch", value: true },
            ],
          },
        ],
      },
      {
        id: "switch-drop",
        cases: [{ when: { kind: "always" }, bypass: ["missing"] }],
      },
    ],
    slots: {
      output: { kind: "output" },
    },
    media_fallbacks: [
      { node_id: "1", input: "image" },
      { node_id: "2", input: "image", when: { node_id: "1" } },
      { node_id: "2", input: "image", when: { node_id: "missing" } },
      { node_id: "missing", input: "image" },
    ],
    pipeline: [
      {
        id: "mask-keep",
        kind: "mask_processing",
        targets: [
          { node_id: "1", input: "mask" },
          { node_id: "missing", input: "mask" },
        ],
      },
      {
        id: "mask-drop",
        kind: "mask_processing",
        targets: [{ node_id: "missing", input: "mask" }],
      },
      {
        id: "ratio-keep",
        kind: "aspect_ratio",
        targets: [
          { node_id: "2", input: "width" },
          { node_id: "missing", input: "width" },
        ],
      },
      {
        id: "ratio-drop",
        kind: "aspect_ratio",
        targets: [],
      },
      { id: "assembly", kind: "output_assembly" },
    ],
  } as unknown as WorkflowRules;
}

describe("workflowState rule pruning", () => {
  it("returns stable empty/default rules for absent workflows", () => {
    expect(pruneWorkflowRulesForWorkflows([], null)).toBe(EMPTY_WORKFLOW_RULES);

    const result = pruneWorkflowRulesForWorkflows([], rulesFixture());
    expect(result.name).toBe("Fixture");
    expect(result.default_widgets_mode).toBe("manual");
    expect(result.slots).toEqual({ output: { kind: "output" } });
    expect(result.nodes).toEqual({});
  });

  it("removes stale references across all rule sections", () => {
    const result = pruneWorkflowRulesForWorkflows(
      [workflow({ "1": "LoadImage", "2": "KSampler" }), null, undefined],
      rulesFixture(),
    );

    expect(Object.keys(result.nodes ?? {})).toEqual(["1"]);
    expect(result.nodes?.["1"]?.widgets?.seed?.default_overrides).toHaveLength(1);
    expect(result.nodes?.["1"]?.ignore_overrides).toHaveLength(1);
    expect(result.validation?.inputs).toEqual([
      { kind: "required", input: "1" },
      {
        kind: "at_least_n",
        inputs: ["1:image", "2:image"],
        min: 2,
      },
    ]);
    expect(result.input_conditions).toEqual([
      { kind: "at_least_one", inputs: ["1"] },
    ]);
    expect(result.derived_widgets).toHaveLength(1);
    expect(result.rewrites).toEqual([]);
    // Effect switches survive pruning: dropping them silently is what made a
    // regenerated workflow ignore its denoise-conditioned switch.
    expect(result.effect_switches?.map((entry) => entry.id)).toEqual([
      "switch-keep",
    ]);
    expect(result.effect_switches?.[0]?.cases).toHaveLength(1);
    expect(result.media_fallbacks).toHaveLength(2);
    expect(result.pipeline?.map((stage) => stage.id)).toEqual(["assembly"]);
    expect(Object.keys(result.frontend_controls ?? {})).toEqual([
      "control-keep",
    ]);
    expect(
      result.frontend_controls?.["control-keep"]?.default_overrides,
    ).toHaveLength(1);
  });

  it("prunes every section the backend rules schema defines", () => {
    // The pruner rewrites each section by hand. When a new top-level section
    // is added to the schema this fails, forcing a decision: prune it, or
    // accept the pass-through `carryUnprunedSections` gives it by default.
    // vitest runs with `frontend/` as the working directory.
    const schemaPath = resolve(
      process.cwd(),
      "../backend/services/workflow_rules/schema/resolved_workflow_rules.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties: Record<string, unknown>;
    };

    expect([...PRUNED_WORKFLOW_RULE_SECTIONS].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
  });

  it("preserves every schema section whose references are all live", () => {
    // Membership in PRUNED_WORKFLOW_RULE_SECTIONS only says a section was
    // considered. This asserts it is actually handled: with nothing to prune,
    // every section must survive intact. Dropping `effect_switches` and
    // `sections` both hid behind the weaker check.
    const live = workflow({ "1": "LoadImage" });
    const rules = {
      version: 3,
      name: "Live",
      default_widgets_mode: "manual",
      sections: [
        { id: "advanced", title: "Advanced", order: 1, default_open: false },
      ],
      nodes: { "1": { present: { label: "Image" } } },
      validation: { inputs: [{ kind: "required", input: "1" }] },
      input_conditions: [{ kind: "at_least_one", inputs: ["1"] }],
      frontend_controls: { "control-a": { label: "A" } },
      derived_widgets: [
        {
          id: "d",
          kind: "video_audio_retake",
          video_bypass: { node_id: "1", param: "switch" },
          audio_bypass: { node_id: "1", param: "switch" },
        },
      ],
      rewrites: [
        {
          when: {
            kind: "compare",
            ref: { kind: "frontend_control", control_id: "control-a" },
            operator: "eq",
            value: true,
          },
          bypass: ["1"],
        },
      ],
      effect_switches: [
        {
          id: "s",
          cases: [
            { when: { kind: "always" }, bypass: ["1"] },
            {
              when: { kind: "always" },
              set_widgets: [{ node_id: "1", widget: "switch", value: false }],
            },
          ],
        },
      ],
      slots: { output: { kind: "output" } },
      pipeline: [
        {
          id: "mask",
          kind: "mask_processing",
          targets: [
            {
              source: { node_id: "1", param: "video" },
              mask: { node_id: "1", param: "mask" },
            },
          ],
        },
      ],
      media_fallbacks: [{ kind: "dummy", node_id: "1", input_type: "image" }],
    } as unknown as WorkflowRules;

    // Keep the fixture honest as the schema grows.
    expect(Object.keys(rules).sort()).toEqual(
      [...PRUNED_WORKFLOW_RULE_SECTIONS].sort(),
    );

    const result = pruneWorkflowRulesForWorkflows([live], rules) as unknown as
      Record<string, unknown>;
    for (const section of PRUNED_WORKFLOW_RULE_SECTIONS) {
      expect({ [section]: result[section] }).toEqual({
        [section]: (rules as unknown as Record<string, unknown>)[section],
      });
    }
  });

  it("carries sections it does not know how to prune", () => {
    // A backend newer than this bundle can send a section these types have
    // never heard of. Passing it through beats deleting it silently.
    const rules = {
      version: 3,
      nodes: { "1": { present: { label: "Image" } } },
      future_section: [{ node_id: "1" }],
    } as unknown as WorkflowRules;

    const result = pruneWorkflowRulesForWorkflows(
      [workflow({ "1": "LoadImage" })],
      rules,
    ) as unknown as Record<string, unknown>;
    expect(result.future_section).toEqual([{ node_id: "1" }]);

    const withoutWorkflow = pruneWorkflowRulesForWorkflows(
      [],
      rules,
    ) as unknown as Record<string, unknown>;
    expect(withoutWorkflow.future_section).toEqual([{ node_id: "1" }]);
  });

  it("keeps rule fragments without node references", () => {
    const rules = {
      version: 1,
      rewrites: [{ kind: "noop", when: { value: true } }],
      pipeline: [{ id: "custom", kind: "custom" }],
    } as unknown as WorkflowRules;
    const result = pruneWorkflowRulesForWorkflows(
      [workflow({ "1": "Node" })],
      rules,
    );
    expect(result.rewrites).toHaveLength(1);
    expect(result.pipeline).toHaveLength(1);
  });
});

describe("workflowState compatibility helpers", () => {
  it.each([
    ["nodes", { nodes: { "1": {} } }],
    ["validation", { validation: { inputs: [{ kind: "required", input: "1" }] } }],
    ["conditions", { input_conditions: [{ kind: "at_least_one", inputs: ["1"] }] }],
    ["derived", { derived_widgets: [{ id: "d" }] }],
    ["rewrites", { rewrites: [{}] }],
    ["effect switches", { effect_switches: [{ id: "s" }] }],
    ["fallbacks", { media_fallbacks: [{}] }],
    ["pipeline", { pipeline: [{ id: "p", kind: "mask_processing" }] }],
  ])("detects node-linked %s rules", (_name, partial) => {
    expect(
      hasNodeLinkedWorkflowRules(partial as unknown as WorkflowRules),
    ).toBe(true);
  });

  it("treats output-only pipeline rules as not node-linked", () => {
    expect(
      hasNodeLinkedWorkflowRules({
        version: 1,
        pipeline: [{ id: "output", kind: "output_assembly" }],
      } as unknown as WorkflowRules),
    ).toBe(false);
    expect(hasNodeLinkedWorkflowRules(null)).toBe(false);
  });

  it.each([
    ["frontend controls", { frontend_controls: { control: {} } }],
    ["slots", { slots: { output: {} } }],
    ["pipeline", { pipeline: [{ id: "output", kind: "output_assembly" }] }],
  ])("detects non-empty %s", (_name, partial) => {
    expect(
      areWorkflowRulesEffectivelyEmpty(
        partial as unknown as WorkflowRules,
      ),
    ).toBe(false);
  });

  it("recognizes empty and populated rules", () => {
    expect(areWorkflowRulesEffectivelyEmpty(null)).toBe(true);
    expect(areWorkflowRulesEffectivelyEmpty(EMPTY_WORKFLOW_RULES)).toBe(true);
    expect(areWorkflowRulesEffectivelyEmpty(rulesFixture())).toBe(false);
  });

  it("reports every kind of lost rule fragment", () => {
    const previous = rulesFixture();
    const next = {
      ...rulesFixture(),
      nodes: {},
      pipeline: [],
      derived_widgets: [],
      rewrites: [],
      effect_switches: [],
      media_fallbacks: [],
    } as WorkflowRules;
    const loss = findLostRuleFragments(previous, next);
    expect(loss.pipelineStageIds).toHaveLength(5);
    expect(loss.nodeIds).toEqual(["1", "missing"]);
    expect(loss.derivedWidgetIds).toEqual(["derived-keep", "derived-drop"]);
    expect(loss.rewriteCount).toBe(2);
    expect(loss.effectSwitchIds).toEqual(["switch-keep", "switch-drop"]);
    expect(loss.mediaFallbackCount).toBe(4);
    expect(loss.hasLoss).toBe(true);
    expect(findLostRuleFragments(null, null).hasLoss).toBe(false);
  });

  it("counts a dropped effect-switch case as loss", () => {
    const previous = rulesFixture();
    const next = {
      ...rulesFixture(),
      effect_switches: [
        {
          ...(rulesFixture().effect_switches ?? [])[0],
          cases: [(rulesFixture().effect_switches ?? [])[0].cases?.[0]],
        },
        (rulesFixture().effect_switches ?? [])[1],
      ],
    } as WorkflowRules;

    const loss = findLostRuleFragments(previous, next);
    // The switch itself survives, so ids alone report nothing: first-match
    // ordering makes a missing case just as behaviour-changing.
    expect(loss.effectSwitchIds).toEqual([]);
    expect(loss.effectSwitchCaseCount).toBe(1);
    expect(loss.hasLoss).toBe(true);
  });

  it("compares workflow node identities with a configurable Jaccard threshold", () => {
    const left = workflow({ "1": "A", "2": "B", "3": "C" });
    expect(
      haveSubstantialWorkflowOverlap([left], [workflow({ "1": "A", "2": "B" })]),
    ).toBe(true);
    expect(
      haveSubstantialWorkflowOverlap(
        [left],
        [workflow({ "1": "Wrong", "4": "D" })],
        0.1,
      ),
    ).toBe(false);
    expect(haveSubstantialWorkflowOverlap([], [left])).toBe(false);
    expect(haveSubstantialWorkflowOverlap([left], [])).toBe(false);
  });

  it("checks compatibility and applicability after pruning", () => {
    const matching = workflow({ "1": "LoadImage", "2": "KSampler" });
    const unrelated = workflow({ "9": "Other" });
    const rules = {
      version: 1,
      nodes: { "1": { present: { label: "Image" } } },
    } as unknown as WorkflowRules;
    expect(areWorkflowRulesCompatibleWithWorkflow(matching, rules)).toBe(true);
    expect(areWorkflowRulesCompatibleWithWorkflow(unrelated, rules)).toBe(
      false,
    );
    expect(areWorkflowRulesCompatibleWithWorkflow(null, null)).toBe(true);
    expect(hasApplicableWorkflowRules([matching], rules)).toBe(true);
    expect(hasApplicableWorkflowRules([unrelated], rules)).toBe(false);
  });
});

describe("workflowState adapter helpers", () => {
  it("applies empty presentation rules and resolves empty widget inputs", () => {
    const inferred = [
      {
        nodeId: "1",
        classType: "LoadImage",
        inputType: "image",
        param: "image",
        label: "Image",
        currentValue: null,
        origin: "inferred",
      },
    ] as const;

    expect(applyPresentationRules([...inferred], null).inputs).toHaveLength(1);
    expect(resolveWidgetInputs(null, null)).toEqual([]);
  });
});
