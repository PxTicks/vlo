import { describe, expect, it } from "vitest";

import {
  buildBridgeEffectPayload,
  captureGenerationEffectsForPlan,
  collectGenerationEffectErrors,
  normalizeGenerationGraphEffects,
} from "../generationGraphEffects";
import type { GenerationPlan } from "../types";
import type { WorkflowRules } from "../../services/workflowRules";

function makePlan(options: {
  workflowRules?: unknown;
  bypassNodeIds?: string[];
  frontendStateWidgetValues?: Record<string, unknown>;
} = {}): GenerationPlan {
  return {
    id: "plan-1",
    createdAt: 0,
    workflow: {
      workflow: null,
      graphData: null,
      workflowId: "workflow.json",
      workflowRules: (options.workflowRules ?? null) as WorkflowRules | null,
      workflowInputs: [],
      submittedWorkflow: null,
      promptIsPreResolved: false,
    },
    preprocess: {
      slotValues: {},
      derivedMaskMappings: [],
      projectConfig: { fps: 30, aspectRatio: "16:9" },
      exactAspectRatio: false,
      targetResolution: 720,
      maskCropDilation: 0,
      maskCropMode: "full",
    },
    submission: {
      widgetInputs: {},
      frontendStateWidgetValues: options.frontendStateWidgetValues ?? {},
      inputMetadata: {},
      widgetModes: {},
      derivedWidgetInputs: {},
      bypassNodeIds: options.bypassNodeIds ?? [],
    },
    metadata: {
      generationMetadata: {} as GenerationPlan["metadata"]["generationMetadata"],
      workflowWarnings: [],
    },
    postprocess: {
      config: {
        mode: "auto",
        panel_preview: "raw_outputs",
        on_failure: "fallback_raw",
      },
    },
    effects: null,
  };
}

const EXPECTATION = { workflowInstanceId: "instance-1", revision: 3 };

describe("captureGenerationEffectsForPlan", () => {
  it("translates rule and panel effect sources into the closed union with attribution", () => {
    const plan = makePlan({
      workflowRules: {
        nodes: {
          "5": {
            widgets: {
              seed: {
                default_overrides: [{ when: { kind: "always" }, value: 7 }],
              },
            },
          },
        },
        rewrites: [
          {
            when: { kind: "always" },
            bypass: ["7"],
            set_widgets: [{ node_id: "5", widget: "steps", value: 20 }],
          },
        ],
        effect_switches: [
          { cases: [{ when: { kind: "always" }, bypass: ["8"] }] },
        ],
      },
      bypassNodeIds: ["9"],
    });

    const captured = captureGenerationEffectsForPlan(
      plan,
      new Set(),
      EXPECTATION,
    );

    expect(captured.schemaVersion).toBe(1);
    expect(captured.expectation).toEqual(EXPECTATION);
    expect(captured.diagnostics).toEqual([]);
    expect(captured.effects).toEqual([
      {
        kind: "set-widget",
        target: { nodeId: "5", widget: "seed" },
        value: 7,
        source: "rule-default-override",
      },
      { kind: "bypass-nodes", nodeIds: ["7"], source: "rule-rewrite" },
      {
        kind: "set-widget",
        target: { nodeId: "5", widget: "steps" },
        value: 20,
        source: "rule-rewrite",
      },
      { kind: "bypass-nodes", nodeIds: ["8"], source: "rule-effect-switch" },
      { kind: "bypass-nodes", nodeIds: ["9"], source: "panel-bypass" },
    ]);
  });

  it("evaluates input-presence conditions from the supplied provided inputs, deterministically", () => {
    const plan = makePlan({
      workflowRules: {
        rewrites: [
          {
            when: {
              kind: "input_presence",
              inputs: ["input-a"],
              match: "all_missing",
            },
            bypass: ["12"],
          },
        ],
      },
    });

    const missing = captureGenerationEffectsForPlan(plan, new Set(), null);
    expect(missing.effects).toEqual([
      { kind: "bypass-nodes", nodeIds: ["12"], source: "rule-rewrite" },
    ]);
    expect(missing.expectation).toBeNull();

    const provided = captureGenerationEffectsForPlan(
      plan,
      new Set(["input-a"]),
      EXPECTATION,
    );
    expect(provided.effects).toEqual([]);

    // Same inputs must produce a deep-equal capture.
    expect(captureGenerationEffectsForPlan(plan, new Set(), null)).toEqual(
      missing,
    );
  });

  it("removes exact duplicates, keeping the first source's attribution", () => {
    const plan = makePlan({
      workflowRules: {
        nodes: {
          "5": {
            widgets: {
              opts: {
                default_overrides: [
                  { when: { kind: "always" }, value: { b: 2, a: 1 } },
                ],
              },
            },
          },
        },
        rewrites: [
          {
            when: { kind: "always" },
            bypass: ["7", "7"],
            // Same value with different key order: still an exact duplicate.
            set_widgets: [{ node_id: "5", widget: "opts", value: { a: 1, b: 2 } }],
          },
        ],
        effect_switches: [
          { cases: [{ when: { kind: "always" }, bypass: ["7"] }] },
        ],
      },
      bypassNodeIds: ["7"],
    });

    const captured = captureGenerationEffectsForPlan(plan, new Set(), null);

    expect(captured.diagnostics).toEqual([]);
    expect(captured.effects).toEqual([
      {
        kind: "set-widget",
        target: { nodeId: "5", widget: "opts" },
        value: { a: 1, b: 2 },
        source: "rule-default-override",
      },
      { kind: "bypass-nodes", nodeIds: ["7"], source: "rule-rewrite" },
    ]);
  });

  it("records widget collisions with the later write winning", () => {
    const plan = makePlan({
      workflowRules: {
        nodes: {
          "5": {
            widgets: {
              seed: {
                default_overrides: [{ when: { kind: "always" }, value: 1 }],
              },
            },
          },
        },
        rewrites: [
          {
            when: { kind: "always" },
            set_widgets: [{ node_id: "5", widget: "seed", value: 2 }],
          },
        ],
      },
    });

    const captured = captureGenerationEffectsForPlan(plan, new Set(), null);

    expect(captured.effects).toEqual([
      {
        kind: "set-widget",
        target: { nodeId: "5", widget: "seed" },
        value: 2,
        source: "rule-rewrite",
      },
    ]);
    expect(captured.diagnostics).toEqual([
      {
        severity: "warning",
        code: "widget-collision",
        source: "rule-rewrite",
        message: expect.stringContaining("5.seed"),
      },
    ]);
    expect(collectGenerationEffectErrors(captured)).toEqual([]);
  });
});

describe("normalizeGenerationGraphEffects", () => {
  it("flags invalid targets and unserializable values as errors and drops them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const { effects, diagnostics } = normalizeGenerationGraphEffects([
      {
        source: "rule-rewrite",
        bypassNodeIds: ["", 5 as unknown as string, "ok-node"],
        widgetOverrides: [
          { node_id: "", widget: "w", value: 1 },
          { node_id: "5", widget: " ", value: 1 },
          { node_id: "5", widget: "nan", value: Number.NaN },
          { node_id: "5", widget: "missing" },
          { node_id: "5", widget: "cyclic", value: cyclic },
          { node_id: "5", widget: "fine", value: null },
        ],
      },
    ]);

    expect(effects).toEqual([
      { kind: "bypass-nodes", nodeIds: ["ok-node"], source: "rule-rewrite" },
      {
        kind: "set-widget",
        target: { nodeId: "5", widget: "fine" },
        value: null,
        source: "rule-rewrite",
      },
    ]);
    expect(diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["error", "invalid-target"],
      ["error", "invalid-target"],
      ["error", "invalid-target"],
      ["error", "invalid-target"],
      ["error", "invalid-value"],
      ["error", "invalid-value"],
      ["error", "invalid-value"],
    ]);
    expect(
      collectGenerationEffectErrors({
        schemaVersion: 1,
        expectation: null,
        effects,
        diagnostics,
      }),
    ).toHaveLength(7);
  });

  it("forwards syntactically valid targets that no node may answer for", () => {
    // Existence is the bridge's call, not this module's: it resolves every
    // target against the live graph and fails the whole resolve with
    // `graph-override-target-missing` (bridge-core.mjs) when one is unknown.
    // Re-checking here against a snapshot of the graph could only produce
    // disagreements, so unknown ids pass through unchanged.
    const { effects, diagnostics } = normalizeGenerationGraphEffects([
      {
        source: "rule-rewrite",
        bypassNodeIds: ["no-such-node"],
        widgetOverrides: [
          { node_id: "no-such-node", widget: "no-such-widget", value: 1 },
        ],
      },
    ]);

    expect(diagnostics).toEqual([]);
    expect(buildBridgeEffectPayload(effects)).toEqual({
      bypassNodeIds: ["no-such-node"],
      widgetOverrides: [
        { node_id: "no-such-node", widget: "no-such-widget", value: 1 },
      ],
    });
  });

  it("trims whitespace from targets before matching", () => {
    const { effects, diagnostics } = normalizeGenerationGraphEffects([
      {
        source: "panel-bypass",
        bypassNodeIds: [" 7 "],
        widgetOverrides: [],
      },
      {
        source: "rule-rewrite",
        bypassNodeIds: ["7"],
        widgetOverrides: [],
      },
    ]);
    expect(effects).toEqual([
      { kind: "bypass-nodes", nodeIds: ["7"], source: "panel-bypass" },
    ]);
    expect(diagnostics).toEqual([]);
  });
});

describe("buildBridgeEffectPayload", () => {
  it("flattens normalized effects into resolve-prompt arguments", () => {
    expect(
      buildBridgeEffectPayload([
        { kind: "bypass-nodes", nodeIds: ["7", "8"], source: "rule-rewrite" },
        {
          kind: "set-widget",
          target: { nodeId: "5", widget: "seed" },
          value: 2,
          source: "rule-rewrite",
        },
        { kind: "bypass-nodes", nodeIds: ["9"], source: "panel-bypass" },
      ]),
    ).toEqual({
      bypassNodeIds: ["7", "8", "9"],
      widgetOverrides: [{ node_id: "5", widget: "seed", value: 2 }],
    });
  });
});
