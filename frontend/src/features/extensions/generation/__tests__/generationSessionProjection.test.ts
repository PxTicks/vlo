import { beforeEach, describe, expect, it } from "vitest";
import {
  GENERATION_SNAPSHOT_LIMITS,
  projectGenerationSession,
  resetGenerationSessionProjectionCache,
} from "../generationSessionProjection";
import type {
  GenerationNodeSnapshot,
  GenerationSessionSnapshot,
  GenerationWidgetSnapshot,
} from "../../../generation/services/generationSessionTypes";

/**
 * The projection is the whole read surface an extension sees, so what it
 * refuses to carry matters as much as what it copies
 * (docs/generation-extension-surface-plan.md §2.1).
 */

function widget(
  overrides: Partial<GenerationWidgetSnapshot> = {},
): GenerationWidgetSnapshot {
  return {
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
    ...overrides,
  };
}

function node(overrides: Partial<GenerationNodeSnapshot> = {}): GenerationNodeSnapshot {
  return {
    id: "10",
    classType: "LoraLoader",
    title: "Load LoRA",
    mode: 0,
    widgets: [widget()],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<GenerationSessionSnapshot> = {},
): GenerationSessionSnapshot {
  return {
    revision: 1,
    workflow: {
      sourceId: "workflow.json",
      instanceId: "instance-1",
      revision: 1,
      fingerprint: "fingerprint-1",
      mode: "catalogue",
      nodes: [node()],
    },
    inputs: [],
    editableWidgets: [],
    readiness: { isLoading: false, isReady: true, hasError: false },
    submission: { isBusy: false, queuedCount: 0, canSubmit: true },
    ...overrides,
  };
}

function onlyWidget(session: GenerationSessionSnapshot) {
  return projectGenerationSession(session).session.workflow.nodes[0].widgets[0];
}

beforeEach(() => {
  resetGenerationSessionProjectionCache();
});

describe("projectGenerationSession", () => {
  it("carries class and widget metadata but nothing about connectivity", () => {
    const { session } = projectGenerationSession(snapshot());
    const [projected] = session.workflow.nodes;

    expect(projected).toEqual({
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
          editable: false,
        },
      ],
    });
    // No inputs, ports, or links: discovery is class-and-widget only.
    expect(Object.keys(projected)).not.toContain("inputs");
  });

  it("marks a widget editable only when the panel binds a control to it", () => {
    const session = snapshot({
      editableWidgets: [
        {
          target: { nodeId: "10", widget: "lora_name" },
          valueType: "enum",
          value: "sharp.safetensors",
          options: ["sharp.safetensors"],
          min: null,
          max: null,
          trueValue: null,
          falseValue: null,
        },
      ],
    });

    expect(onlyWidget(session).editable).toBe(true);
    expect(onlyWidget(snapshot()).editable).toBe(false);
  });

  it("publishes the constraints a write is actually judged against", () => {
    // The catalogue comes from the synced prompt and `object_info`; the panel
    // binding comes from the control and the workflow rules, and it is what
    // `setWidget` validates against. Where they disagree, the binding wins.
    const session = snapshot({
      workflow: {
        ...snapshot().workflow,
        nodes: [
          node({
            widgets: [
              widget({
                param: "steps",
                valueType: "int",
                value: 20,
                options: null,
                min: null,
                max: null,
                step: 1,
              }),
            ],
          }),
        ],
      },
      editableWidgets: [
        {
          target: { nodeId: "10", widget: "steps" },
          valueType: "int",
          value: 35,
          options: null,
          min: 1,
          max: 100,
          trueValue: null,
          falseValue: null,
        },
      ],
    });

    expect(onlyWidget(session)).toMatchObject({
      valueType: "int",
      value: 35,
      min: 1,
      max: 100,
      // Still the catalogue's, which is the only source for it.
      step: 1,
      editable: true,
    });
  });

  it("publishes every binding's constraints, not just the first", () => {
    // The host accepts a value when *any* control bound to the target accepts
    // it, so publishing one binding would describe a narrower widget than the
    // one being validated.
    const session = snapshot({
      editableWidgets: [
        {
          target: { nodeId: "10", widget: "lora_name" },
          valueType: "enum",
          value: "sharp.safetensors",
          options: ["sharp.safetensors"],
          min: null,
          max: null,
          trueValue: null,
          falseValue: null,
        },
        {
          target: { nodeId: "10", widget: "lora_name" },
          valueType: "enum",
          value: "sharp.safetensors",
          options: ["soft.safetensors"],
          min: null,
          max: null,
          trueValue: null,
          falseValue: null,
        },
      ],
    });

    expect(onlyWidget(session).options).toEqual([
      "sharp.safetensors",
      "soft.safetensors",
    ]);
  });

  it("publishes an unrestricted binding as unrestricted", () => {
    // An enum binding with no options accepts any scalar, so borrowing the
    // catalogue's list here would advertise a closed set the host does not
    // enforce — a write outside it would succeed.
    const session = snapshot({
      editableWidgets: [
        {
          target: { nodeId: "10", widget: "lora_name" },
          valueType: "enum",
          value: "anything.safetensors",
          options: null,
          min: null,
          max: null,
          trueValue: null,
          falseValue: null,
        },
      ],
    });

    const projected = onlyWidget(session);
    expect(projected.options).toBeNull();
    expect(projected.editable).toBe(true);
  });

  it("publishes the outer envelope of several bound ranges", () => {
    const ranged = (min: number, max: number, valueType: "int" | "float") => ({
      target: { nodeId: "10", widget: "steps" },
      valueType,
      value: 20,
      options: null,
      min,
      max,
      trueValue: null,
      falseValue: null,
    });
    const session = snapshot({
      workflow: {
        ...snapshot().workflow,
        nodes: [node({ widgets: [widget({ param: "steps", valueType: "int" })] })],
      },
      editableWidgets: [ranged(1, 50, "int"), ranged(10, 100, "float")],
    });

    const projected = onlyWidget(session);
    expect(projected).toMatchObject({ min: 1, max: 100 });
    // Two controls that disagree about the type cannot be described by one:
    // `unknown` is what "the published metadata cannot judge this" means.
    expect(projected.valueType).toBe("unknown");
  });

  it("deeply freezes everything it hands out", () => {
    const source = snapshot();
    const { session } = projectGenerationSession(source);

    expect(() => {
      (session.workflow.nodes as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (session.workflow.nodes[0] as { title: string }).title = "mutated";
    }).toThrow();
    expect(() => {
      (
        session.workflow.nodes[0].widgets[0].options as unknown as unknown[]
      ).push("injected");
    }).toThrow();
    // The host's own snapshot is untouched: the adapter never freezes state it
    // does not own.
    expect(Object.isFrozen(source.workflow.nodes)).toBe(false);
  });

  it("returns one stable object per published snapshot", () => {
    // The host memoizes its catalogue, and the service treats a fresh array as
    // a rebuild, so a stable identity is what a real republish looks like.
    const nodes = [node()];
    const workflow = { ...snapshot().workflow, nodes };
    const first = snapshot({ workflow });
    const projection = projectGenerationSession(first);

    // `useSyncExternalStore` calls the getter on every render; a fresh clone
    // each call would be an endless re-render.
    expect(projectGenerationSession(first).session).toBe(projection.session);

    // A value-only republish keeps the catalogue identity, so a consumer that
    // memoizes on `workflow` does not recompute for a keystroke elsewhere.
    const second = snapshot({
      revision: 2,
      workflow,
      submission: { isBusy: true, queuedCount: 1, canSubmit: false },
    });
    const next = projectGenerationSession(second).session;
    expect(next).not.toBe(projection.session);
    expect(next.workflow.nodes).toBe(projection.session.workflow.nodes);
    expect(next.busy).toBe(true);
    expect(next.canSubmit).toBe(false);
  });

  it("reprojects when the same catalogue gains an editable binding", () => {
    const nodes = [node()];
    const before = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    ).session;
    const after = projectGenerationSession(
      snapshot({
        revision: 2,
        workflow: { ...snapshot().workflow, nodes },
        editableWidgets: [
          {
            target: { nodeId: "10", widget: "lora_name" },
            valueType: "enum",
            value: "sharp.safetensors",
            options: null,
            min: null,
            max: null,
            trueValue: null,
            falseValue: null,
          },
        ],
      }),
    ).session;

    expect(before.workflow.nodes[0].widgets[0].editable).toBe(false);
    expect(after.workflow.nodes[0].widgets[0].editable).toBe(true);
  });

  it("reports a status a consumer can wait on", () => {
    const status = (
      readiness: GenerationSessionSnapshot["readiness"],
    ): string => {
      resetGenerationSessionProjectionCache();
      return projectGenerationSession(snapshot({ readiness })).session.status;
    };

    expect(status({ isLoading: false, isReady: true, hasError: false })).toBe(
      "ready",
    );
    expect(status({ isLoading: true, isReady: false, hasError: false })).toBe(
      "loading",
    );
    // Not ready and not loading is still "wait and watch the revision".
    expect(status({ isLoading: false, isReady: false, hasError: false })).toBe(
      "loading",
    );
    // A failed load is the one state that will not resolve on its own.
    expect(status({ isLoading: false, isReady: false, hasError: true })).toBe(
      "error",
    );
    expect(status({ isLoading: true, isReady: true, hasError: true })).toBe(
      "error",
    );
  });
});

describe("projectGenerationSession limits", () => {
  it("drops an oversized value rather than publishing a truncated one", () => {
    const oversized = "x".repeat(GENERATION_SNAPSHOT_LIMITS.valueLength + 1);
    const projection = projectGenerationSession(
      snapshot({
        workflow: {
          ...snapshot().workflow,
          nodes: [node({ widgets: [widget({ value: oversized })] })],
        },
      }),
    );

    // `null` already means "nothing representable here", so the degraded shape
    // is one the consumer must handle anyway — with a note saying why.
    expect(projection.session.workflow.nodes[0].widgets[0].value).toBeNull();
    expect(projection.truncations).toEqual([
      expect.stringContaining("exceeds"),
    ]);
  });

  it("drops a value nested past the published depth", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index <= GENERATION_SNAPSHOT_LIMITS.valueDepth; index += 1) {
      deep = { next: deep };
    }
    const projection = projectGenerationSession(
      snapshot({
        workflow: {
          ...snapshot().workflow,
          nodes: [
            node({
              widgets: [
                widget({ value: deep as never, valueType: "unknown" }),
              ],
            }),
          ],
        },
      }),
    );

    expect(projection.session.workflow.nodes[0].widgets[0].value).toBeNull();
    expect(projection.truncations).toEqual([expect.stringContaining("nests")]);
  });

  it("caps enum options, nodes, and widgets per node", () => {
    const options = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.optionsPerWidget + 5 },
      (_unused, index) => `model-${index}.safetensors`,
    );
    const widgets = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.widgetsPerNode + 2 },
      (_unused, index) => widget({ param: `param-${index}`, options: null }),
    );
    const nodes = [
      node({ widgets: [widget({ options })] }),
      node({ id: "11", widgets }),
    ];
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    const [first, second] = projection.session.workflow.nodes;
    expect(first.widgets[0].options).toHaveLength(
      GENERATION_SNAPSHOT_LIMITS.optionsPerWidget,
    );
    expect(second.widgets).toHaveLength(
      GENERATION_SNAPSHOT_LIMITS.widgetsPerNode,
    );
    expect(projection.truncations).toHaveLength(2);
  });

  it("caps the node catalogue itself", () => {
    const nodes = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.nodes + 3 },
      (_unused, index) => node({ id: `n${index}`, widgets: [] }),
    );
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    expect(projection.session.workflow.nodes).toHaveLength(
      GENERATION_SNAPSHOT_LIMITS.nodes,
    );
    expect(projection.truncations).toEqual([
      expect.stringContaining("only the first"),
    ]);
  });
});

describe("projectGenerationSession finite JSON", () => {
  it("drops numeric metadata with no JSON form", () => {
    // Upstream `typeof x === "number"` checks admit NaN and the infinities,
    // and none of the three can be published as finite JSON.
    const session = snapshot({
      workflow: {
        ...snapshot().workflow,
        nodes: [
          node({
            mode: Number.NaN,
            widgets: [
              widget({
                valueType: "float",
                min: Number.NaN,
                max: Number.POSITIVE_INFINITY,
                step: Number.NEGATIVE_INFINITY,
                options: ["ok.safetensors", Number.NaN, 3],
              }),
            ],
          }),
        ],
      },
    });
    const projection = projectGenerationSession(session);
    const [projected] = projection.session.workflow.nodes;

    expect(projected.mode).toBe(0);
    expect(projected.widgets[0]).toMatchObject({
      min: null,
      max: null,
      step: null,
    });
    expect(projected.widgets[0].options).toEqual(["ok.safetensors", 3]);
    expect(JSON.parse(JSON.stringify(projection.session))).toEqual(
      projection.session,
    );
  });
});

describe("projectGenerationSession aggregate budgets", () => {
  function manyWidgets(count: number, overrides = {}) {
    return Array.from({ length: count }, (_unused, index) =>
      widget({ param: `param-${index}`, options: null, ...overrides }),
    );
  }

  function countWidgets(
    projection: ReturnType<typeof projectGenerationSession>,
  ): number {
    return projection.session.workflow.nodes.reduce(
      (total, projected) => total + projected.widgets.length,
      0,
    );
  }

  it("caps widgets across the snapshot, not only per node", () => {
    const nodes = Array.from({ length: 100 }, (_unused, index) =>
      node({
        id: `n${index}`,
        widgets: manyWidgets(GENERATION_SNAPSHOT_LIMITS.widgetsPerNode),
      }),
    );
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    expect(countWidgets(projection)).toBe(GENERATION_SNAPSHOT_LIMITS.widgets);
    expect(projection.truncations.length).toBeGreaterThan(0);
  });

  it("caps enum options across the snapshot", () => {
    const options = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.optionsPerWidget },
      (_unused, index) => `model-${index}.safetensors`,
    );
    const nodes = Array.from({ length: 20 }, (_unused, index) =>
      node({ id: `n${index}`, widgets: [widget({ options })] }),
    );
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    const published = projection.session.workflow.nodes.reduce(
      (total, projected) =>
        total + (projected.widgets[0].options?.length ?? 0),
      0,
    );
    expect(published).toBeLessThanOrEqual(GENERATION_SNAPSHOT_LIMITS.options);
  });

  it("stops spending bytes once the value budget is gone", () => {
    const big = "x".repeat(GENERATION_SNAPSHOT_LIMITS.valueLength - 2);
    const nodes = Array.from({ length: 200 }, (_unused, index) =>
      node({
        id: `n${index}`,
        widgets: [widget({ valueType: "string", value: big, options: null })],
      }),
    );
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    const published = projection.session.workflow.nodes.filter(
      (projected) => projected.widgets[0].value !== null,
    );
    // 200 × ~64KB is well past the 4MB budget, so the tail is published as
    // `null` rather than carried.
    expect(published.length).toBeLessThan(nodes.length);
    expect(published.length * big.length).toBeLessThanOrEqual(
      GENERATION_SNAPSHOT_LIMITS.valueBytes,
    );
  });

  it("caps the diagnostics themselves", () => {
    const nodes = Array.from({ length: 200 }, (_unused, index) =>
      node({
        id: `n${index}`,
        widgets: [widget({ value: Number.NaN, options: null })],
      }),
    );
    const projection = projectGenerationSession(
      snapshot({ workflow: { ...snapshot().workflow, nodes } }),
    );

    // One note per dropped item is its own leak; the tail becomes a count.
    expect(projection.truncations.length).toBe(
      GENERATION_SNAPSHOT_LIMITS.diagnostics + 1,
    );
    expect(projection.truncations.at(-1)).toContain("further snapshot limit");
  });

  it("bounds panel inputs by count, size, and total", () => {
    const inputs = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.inputs + 5 },
      (_unused, index) => ({
        id: `${index}:text`,
        nodeId: `${index}`,
        param: "text",
        label: `Prompt ${index}`,
        inputType: "text" as const,
        value: "prompt",
      }),
    );
    inputs[0] = {
      ...inputs[0],
      value: "x".repeat(GENERATION_SNAPSHOT_LIMITS.inputValueLength + 1),
    };
    const projection = projectGenerationSession(snapshot({ inputs }));

    expect(projection.session.inputs).toHaveLength(
      GENERATION_SNAPSHOT_LIMITS.inputs,
    );
    // Published without its value rather than with a shortened one: an
    // extension that read a truncated prompt and wrote it back would destroy
    // the user's text.
    expect(projection.session.inputs[0].value).toBeUndefined();
    expect(projection.session.inputs[1].value).toBe("prompt");
    expect(projection.truncations).toEqual(
      expect.arrayContaining([expect.stringContaining("only the first")]),
    );
  });
});
