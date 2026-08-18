import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GenerationSubmissionContributorRegistry,
  type GenerationContributedEffect,
} from "../generationSubmissionContributors";
import type {
  GenerationNodeSnapshot,
  GenerationSessionSnapshot,
} from "../generationSessionTypes";

/**
 * The host half of E2 (docs/generation-extension-surface-plan.md): when
 * contributors run, in what order, and what a contribution is allowed to say.
 * Owner binding, SDK limits, and callback reporting belong to the adapter and
 * are covered beside it.
 */

const nodes: readonly GenerationNodeSnapshot[] = [
  {
    id: "10",
    classType: "LoraLoader",
    title: "Load LoRA",
    mode: 0,
    widgets: [
      {
        nodeId: "10",
        param: "lora_name",
        valueType: "enum",
        value: "sharp.safetensors",
        defaultValue: "sharp.safetensors",
        options: ["sharp.safetensors", "soft.safetensors"],
        min: null,
        max: null,
        step: null,
        linked: false,
        controlAfterGenerate: false,
      },
      {
        nodeId: "10",
        param: "strength_model",
        valueType: "float",
        value: 1,
        defaultValue: 1,
        options: null,
        min: 0,
        max: 2,
        step: 0.01,
        linked: false,
        controlAfterGenerate: false,
      },
    ],
  },
];

function session(): GenerationSessionSnapshot {
  return {
    revision: 3,
    workflow: {
      sourceId: "workflow.json",
      instanceId: "instance-1",
      revision: 1,
      fingerprint: "fingerprint-1",
      mode: "catalogue",
      nodes,
    },
    inputs: [],
    editableWidgets: [],
    readiness: { isLoading: false, isReady: true, hasError: false },
    submission: { isBusy: false, queuedCount: 0, canSubmit: true },
  };
}

let registry: GenerationSubmissionContributorRegistry;

beforeEach(() => {
  registry = new GenerationSubmissionContributorRegistry();
});

function contributor(id: string, effects: GenerationContributedEffect[]) {
  return { id, contribute: () => effects };
}

describe("GenerationSubmissionContributorRegistry", () => {
  it("collects validated effects with the contributor's attribution", () => {
    registry.register(
      contributor("example.lora/policy", [
        { kind: "bypass-nodes", nodeIds: ["10"] },
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "lora_name" },
          value: "soft.safetensors",
        },
      ]),
    );

    expect(registry.collect(session())).toEqual([
      {
        source: "extension:example.lora/policy",
        workflow: {
          sourceId: "workflow.json",
          instanceId: "instance-1",
          fingerprint: "fingerprint-1",
        },
        bypassNodeIds: ["10"],
        widgetOverrides: [
          {
            node_id: "10",
            widget: "lora_name",
            value: "soft.safetensors",
          },
        ],
        diagnostics: [],
      },
    ]);
  });

  it("runs contributors in registration order", () => {
    const calls: string[] = [];
    registry.register({
      id: "a/one",
      contribute: () => {
        calls.push("a/one");
        return [];
      },
    });
    registry.register({
      id: "b/two",
      contribute: () => {
        calls.push("b/two");
        return [];
      },
    });

    const groups = registry.collect(session());
    expect(calls).toEqual(["a/one", "b/two"]);
    expect(groups.map((group) => group.source)).toEqual([
      "extension:a/one",
      "extension:b/two",
    ]);
  });

  it("refuses a duplicate id and forgets an unregistered contributor", () => {
    const dispose = registry.register(contributor("a/one", []));
    expect(() => registry.register(contributor("a/one", []))).toThrow(
      /already registered/,
    );
    dispose();
    expect(registry.size()).toBe(0);
    expect(registry.collect(session())).toEqual([]);
    // Registering again is fine once the id is free.
    expect(() => registry.register(contributor("a/one", []))).not.toThrow();
  });

  it("fails the submission when a contributor throws", () => {
    registry.register({
      id: "a/one",
      contribute: () => {
        throw new Error("policy exploded");
      },
    });

    const [group] = registry.collect(session());
    expect(group.bypassNodeIds).toEqual([]);
    expect(group.widgetOverrides).toEqual([]);
    // An error, not a warning: the contribution is policy the user set up, and
    // generating without it spends GPU time on a result nobody asked for.
    expect(group.diagnostics).toEqual([
      {
        severity: "error",
        code: "contributor-failed",
        source: "extension:a/one",
        message: expect.stringContaining("policy exploded"),
      },
    ]);
  });

  it("rejects a return value that is not an array of effects", () => {
    registry.register({
      id: "a/one",
      contribute: () => undefined as unknown as GenerationContributedEffect[],
    });
    expect(registry.collect(session())[0].diagnostics[0]).toMatchObject({
      code: "contributor-failed",
    });
  });

  it("rejects targets the mounted workflow does not contain", () => {
    registry.register(
      contributor("a/one", [
        { kind: "bypass-nodes", nodeIds: ["404"] },
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "nope" },
          value: 1,
        },
      ]),
    );

    const [group] = registry.collect(session());
    expect(group.bypassNodeIds).toEqual([]);
    expect(group.widgetOverrides).toEqual([]);
    expect(group.diagnostics.map((entry) => entry.code)).toEqual([
      "invalid-target",
      "invalid-target",
    ]);
  });

  it("judges values against the catalogue, not the panel's controls", () => {
    // `strength_model` has no panel control at all here — reaching it is the
    // reason effects exist — but the catalogue's range still binds.
    registry.register(
      contributor("a/one", [
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "strength_model" },
          value: 0.8,
        },
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "lora_name" },
          value: "absent.safetensors",
        },
      ]),
    );

    const [group] = registry.collect(session());
    expect(group.widgetOverrides).toEqual([
      { node_id: "10", widget: "strength_model", value: 0.8 },
    ]);
    expect(group.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-value" }),
    ]);
  });

  it("rejects a value that is not finite JSON", () => {
    registry.register(
      contributor("a/one", [
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "strength_model" },
          value: Number.NaN,
        },
      ]),
    );
    expect(registry.collect(session())[0].diagnostics[0]).toMatchObject({
      code: "invalid-value",
    });
  });

  it("caps how much one contributor may contribute", () => {
    registry.register(
      contributor(
        "a/one",
        Array.from({ length: 65 }, () => ({
          kind: "bypass-nodes" as const,
          nodeIds: ["10"],
        })),
      ),
    );
    const [group] = registry.collect(session());
    expect(group.bypassNodeIds).toEqual([]);
    expect(group.diagnostics[0]).toMatchObject({ code: "invalid-target" });
  });

  it("does nothing at all when nobody has registered", () => {
    const contribute = vi.fn();
    expect(registry.collect(null)).toEqual([]);
    expect(contribute).not.toHaveBeenCalled();
  });

  it("fails closed when there is no session to plan against", () => {
    registry.register(contributor("a/one", []));
    expect(registry.collect(null)).toEqual([
      {
        source: "extension:a/one",
        workflow: { sourceId: null, instanceId: null, fingerprint: "" },
        bypassNodeIds: [],
        widgetOverrides: [],
        diagnostics: [
          expect.objectContaining({ code: "contributor-failed" }),
        ],
      },
    ]);
  });
  it("refuses to plan against a session describing another workflow", () => {
    const contribute = vi.fn(() => []);
    registry.register({ id: "a/one", contribute });

    // The panel publishes the session from an effect, so a snapshot for the
    // workflow that was open a moment ago is an ordinary race. Node ids are
    // unique within a workflow only, so filing those effects under this
    // submission would let the bridge apply them to the wrong graph.
    const [group] = registry.collect(session(), {
      sourceId: "other.json",
      instanceId: "instance-1",
    });

    expect(contribute).not.toHaveBeenCalled();
    expect(group.diagnostics[0]).toMatchObject({
      code: "contributor-failed",
      message: expect.stringContaining("different workflow"),
    });
  });

  it("runs when the submission and the session agree", () => {
    const contribute = vi.fn(() => []);
    registry.register({ id: "a/one", contribute });

    registry.collect(session(), {
      sourceId: "workflow.json",
      instanceId: "instance-1",
    });
    expect(contribute).toHaveBeenCalledTimes(1);
  });

  it("caps target lengths and value size for a native caller too", () => {
    const long = "x".repeat(513);
    registry.register(
      contributor("a/one", [
        { kind: "bypass-nodes", nodeIds: [long] },
        {
          kind: "set-widget",
          target: { nodeId: long, widget: "lora_name" },
          value: "sharp.safetensors",
        },
        {
          kind: "set-widget",
          target: { nodeId: "10", widget: "lora_name" },
          value: "y".repeat(100_001),
        },
      ]),
    );

    // The SDK adapter checks these first, but a bound only one path enforces
    // is not a bound.
    const [group] = registry.collect(session());
    expect(group.bypassNodeIds).toEqual([]);
    expect(group.widgetOverrides).toEqual([]);
    expect(group.diagnostics.map((entry) => entry.code)).toEqual([
      "invalid-target",
      "invalid-target",
      "invalid-value",
    ]);
  });
});
