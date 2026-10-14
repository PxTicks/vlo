import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionTransitionDefinition,
  ExtensionTransitionFrame,
  ExtensionTransitionRenderInput,
  ExtensionTransitionZOrder,
} from "../../../extensions/types";
import type {
  TimelineClip,
  Transition,
} from "../../../../types/TimelineTypes";
import {
  ExtensionTransitionRegistry,
  extensionTransitionRegistry,
} from "../ExtensionTransitionRegistry";
import { validateTransitionParameterUpdates } from "../../catalogue/TransitionRegistry";

function createScope(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function clip(id: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId: "track-1",
    assetId: `asset-${id}`,
    start: 0,
    timelineDuration: 100,
    sourceDuration: 100,
    croppedSourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

function transition(): Transition {
  return {
    id: "transition-1",
    type: "example.transitions/wipe",
    outgoingClipId: "outgoing",
    incomingClipId: "incoming",
    schemaVersion: 1,
    parameters: { strength: 0.5 },
  };
}

describe("ExtensionTransitionRegistry", () => {
  it("registers owner-qualified transition definitions and disposes them", () => {
    const registry = new ExtensionTransitionRegistry();
    const registration = registry.bind(createScope("example.transitions")).register({
      id: "wipe",
      apiVersion: 1,
      label: "Wipe",
      glyph: "W",
      schemaVersion: 1,
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            {
              type: "slider",
              name: "strength",
              label: "Strength",
              defaultValue: 0.5,
              min: 0,
              max: 1,
            },
          ],
        },
      ],
      renderFrame: ({ progress, parameters }) => ({
        outgoingTransforms: [
          {
            id: "shift",
            type: "position",
            parameters: {
              x: -100 * progress * Number(parameters.strength),
              y: 0,
            },
          },
        ],
      }),
    });

    const definition = registry.getDefinition("example.transitions/wipe");
    expect(definition).toMatchObject({
      type: "example.transitions/wipe",
      label: "Wipe",
      schemaVersion: 1,
      parameters: { strength: 0.5 },
    });

    const frame = definition?.renderFrame?.({
      transition: transition(),
      outgoingClip: clip("outgoing"),
      incomingClip: clip("incoming"),
      progress: 0.5,
      startTick: 50,
      endTick: 100,
      durationTicks: 50,
      presentationTick: 75,
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
    });
    expect(frame?.outgoingTransforms?.[0]).toMatchObject({
      id: "transition-1:extension:outgoing:shift",
      type: "position",
      parameters: { x: -25, y: 0 },
    });

    registration.dispose();
    expect(registry.getDefinition("example.transitions/wipe")).toBeUndefined();
  });

  it("rejects invalid defaults before registration", () => {
    const registry = new ExtensionTransitionRegistry();
    expect(() =>
      registry.bind(createScope("example.transitions")).register({
        id: "bad",
        apiVersion: 1,
        label: "Bad",
        glyph: "B",
        schemaVersion: 1,
        groups: [
          {
            id: "motion",
            title: "Motion",
            controls: [
              {
                type: "slider",
                name: "strength",
                label: "Strength",
                defaultValue: 2,
                min: 0,
                max: 1,
              },
            ],
          },
        ],
        renderFrame: () => ({}),
      }),
    ).toThrow(/invalid numeric bounds/);
  });

  it("validates extension transition parameter updates through the catalogue", () => {
    const registration = extensionTransitionRegistry
      .bind(createScope("example.validation-transitions"))
      .register({
        id: "even",
        apiVersion: 1,
        label: "Even",
        glyph: "E",
        schemaVersion: 1,
        groups: [
          {
            id: "values",
            title: "Values",
            controls: [
              {
                type: "number",
                name: "amount",
                label: "Amount",
                defaultValue: 2,
                min: 0,
                max: 10,
              },
            ],
          },
        ],
        validateParameters: (parameters) =>
          typeof parameters.amount === "number" && parameters.amount % 2 === 0,
        renderFrame: () => ({}),
      });

    try {
      const value: Transition = {
        id: "transition-even",
        type: "example.validation-transitions/even",
        outgoingClipId: "outgoing",
        incomingClipId: "incoming",
        schemaVersion: 1,
        parameters: { amount: 2 },
      };
      expect(validateTransitionParameterUpdates(value, { amount: 3 })).toBe(
        false,
      );
      expect(validateTransitionParameterUpdates(value, { amount: 4 })).toBe(
        true,
      );
    } finally {
      registration.dispose();
    }
  });
});

const BASE_GROUPS: ExtensionTransitionDefinition["groups"] = [
  {
    id: "look",
    title: "Look",
    columns: 2,
    controls: [
      {
        type: "slider",
        name: "amount",
        label: "Amount",
        defaultValue: 1,
        min: 0,
        max: 2,
        step: 0.5,
      },
      { type: "checkbox", name: "flip", label: "Flip", defaultValue: false },
      { type: "text", name: "caption", label: "Caption", defaultValue: "hi" },
      { type: "color", name: "tint", label: "Tint", defaultValue: "#aabbcc" },
      {
        type: "select",
        name: "mode",
        label: "Mode",
        defaultValue: "a",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      },
    ],
  },
];

const BASE_PARAMETERS = {
  amount: 1,
  flip: false,
  caption: "hi",
  tint: "#aabbcc",
  mode: "a",
};

function definitionWith(
  overrides: Partial<ExtensionTransitionDefinition> = {},
): ExtensionTransitionDefinition {
  return {
    id: "fx",
    apiVersion: 1,
    label: "Fx",
    glyph: "F",
    schemaVersion: 2,
    groups: BASE_GROUPS,
    renderFrame: () => ({}),
    ...overrides,
  };
}

function renderContext(
  parameters: Record<string, unknown>,
  schemaVersion: number | undefined = 2,
  id = "transition-render",
) {
  return {
    transition: {
      id,
      type: "example.fx/fx",
      outgoingClipId: "outgoing",
      incomingClipId: "incoming",
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      parameters,
    },
    outgoingClip: clip("outgoing"),
    incomingClip: clip("incoming"),
    progress: 0.25,
    startTick: 0,
    endTick: 100,
    durationTicks: 100,
    presentationTick: 25,
    fps: 30,
    logicalDimensions: { width: 1920, height: 1080 },
  };
}

function registerFx(overrides: Partial<ExtensionTransitionDefinition> = {}) {
  const registry = new ExtensionTransitionRegistry();
  const scope = createScope("example.fx");
  registry.bind(scope).register(definitionWith(overrides));
  const definition = registry.getDefinitionForOwner("example.fx", "fx")!;
  return { registry, scope, definition };
}

describe("ExtensionTransitionRegistry definition validation", () => {
  const control = (value: object) => ({
    groups: [{ id: "g", title: "G", controls: [value] }],
  }) as Partial<ExtensionTransitionDefinition>;

  it.each<[string, Partial<ExtensionTransitionDefinition>, RegExp]>([
    ["api version", { apiVersion: 2 as 1 }, /apiVersion 1/],
    ["blank label", { label: "  " }, /label must be a non-empty string/],
    ["long glyph", { glyph: "x".repeat(13) }, /at most 12 characters/],
    ["schema version", { schemaVersion: 0 }, /positive integer/],
    [
      "missing renderer",
      { renderFrame: undefined as unknown as ExtensionTransitionDefinition["renderFrame"] },
      /must provide renderFrame/,
    ],
    [
      "duplicate group",
      {
        groups: [
          { id: "g", title: "G", controls: [{ type: "checkbox", name: "a", label: "A", defaultValue: true }] },
          { id: "g", title: "G", controls: [{ type: "checkbox", name: "b", label: "B", defaultValue: true }] },
        ],
      },
      /Duplicate transition UI group/,
    ],
    ["empty group", { groups: [{ id: "g", title: "G", controls: [] }] }, /must contain controls/],
    [
      "columns",
      {
        groups: [
          { id: "g", title: "G", columns: 5, controls: [{ type: "checkbox", name: "a", label: "A", defaultValue: true }] },
        ],
      },
      /columns must be an integer from 1 to 4/,
    ],
    [
      "duplicate parameter",
      {
        groups: [
          {
            id: "g",
            title: "G",
            controls: [
              { type: "checkbox", name: "a", label: "A", defaultValue: true },
              { type: "checkbox", name: "a", label: "A2", defaultValue: true },
            ],
          },
        ],
      },
      /Duplicate transition parameter/,
    ],
    [
      "step",
      control({ type: "number", name: "n", label: "N", defaultValue: 0, min: 0, max: 1, step: 0 }),
      /step must be positive/,
    ],
    [
      "text length",
      control({ type: "text", name: "t", label: "T", defaultValue: "x".repeat(10_001) }),
      /default text is too long/,
    ],
    [
      "color",
      control({ type: "color", name: "c", label: "C", defaultValue: "red" }),
      /#RRGGBB color/,
    ],
    [
      "select options",
      control({ type: "select", name: "s", label: "S", defaultValue: "a", options: [] }),
      /must declare select options/,
    ],
    [
      "select default",
      control({ type: "select", name: "s", label: "S", defaultValue: "z", options: [{ label: "A", value: "a" }] }),
      /default must match an option/,
    ],
    [
      "non-JSON default",
      { defaultParameters: { bad: Number.NaN } },
      /default 'bad' must be JSON/,
    ],
    [
      "rejected default",
      { validateParameters: () => false },
      /invalid default parameters/,
    ],
  ])("rejects an invalid %s", (_label, overrides, message) => {
    const registry = new ExtensionTransitionRegistry();
    expect(() =>
      registry.bind(createScope("example.fx")).register(definitionWith(overrides)),
    ).toThrow(message);
  });

  it("builds frozen defaults from controls and explicit default parameters", () => {
    const { definition, registry } = registerFx({
      defaultParameters: { extra: { nested: [1, "two", null] } },
      zOrder: "incoming-on-top",
    });

    expect(definition.parameters).toEqual({
      ...BASE_PARAMETERS,
      extra: { nested: [1, "two", null] },
    });
    expect(Object.isFrozen(definition.parameters)).toBe(true);
    expect(definition.zOrder).toBe("incoming-on-top");
    expect(definition.uiConfig.groups[0]).toMatchObject({ id: "look", columns: 2 });
    expect(registry.listDefinitions()).toEqual([definition]);
  });

  it("validates each control kind and runs the extension validator", () => {
    const validator = vi.fn(
      (parameters: Readonly<Record<string, unknown>>) =>
        parameters.caption !== "nope",
    );
    const { definition } = registerFx({ validateParameters: validator });
    const validate = definition.extension!.validateParameters;

    expect(validate(BASE_PARAMETERS, 2)).toBe(true);
    expect(validate(BASE_PARAMETERS, 1)).toBe(false);
    for (const invalid of [
      { amount: 3 },
      { amount: "1" },
      { flip: "yes" },
      { caption: 4 },
      { tint: "#abc" },
      { mode: "c" },
      { mode: { value: "a" } },
      { caption: "nope" },
      { extra: () => undefined },
    ]) {
      expect(validate({ ...BASE_PARAMETERS, ...invalid }, 2)).toBe(false);
    }
    const { amount: _amount, ...missing } = BASE_PARAMETERS;
    expect(validate(missing, 2)).toBe(false);
  });

  it("reports a throwing validator once and fails closed", () => {
    let shouldThrow = false;
    const { definition, scope } = registerFx({
      validateParameters: () => {
        if (shouldThrow) throw new Error("boom");
        return true;
      },
    });
    shouldThrow = true;
    const validate = definition.extension!.validateParameters;

    expect(validate(BASE_PARAMETERS, 2)).toBe(false);
    expect(validate(BASE_PARAMETERS, 2)).toBe(false);
    expect(scope.report).toHaveBeenCalledTimes(1);
    expect(scope.report).toHaveBeenCalledWith(
      "error",
      "Transition 'example.fx/fx' threw while validating parameters.",
      expect.any(Error),
    );
  });

  it("rejects cyclic parameter objects", () => {
    const { definition } = registerFx({ validateParameters: () => true });
    const cyclic: Record<string, unknown> = { ...BASE_PARAMETERS };
    cyclic.self = cyclic;
    const list: unknown[] = [];
    list.push(list);
    const validate = definition.extension!.validateParameters;
    expect(validate(cyclic, 2)).toBe(false);
    expect(validate({ ...BASE_PARAMETERS, list }, 2)).toBe(false);
    expect(validate({ ...BASE_PARAMETERS, date: new Date() }, 2)).toBe(false);
  });
});

describe("ExtensionTransitionRegistry rendering", () => {
  it("passes a detached render input and normalizes frame output", () => {
    const renderFrame = vi.fn((input: ExtensionTransitionRenderInput) => ({
      outgoingTransforms: [
        {
          type: " filter ",
          parameters: { strength: input.progress },
          isEnabled: false,
          filterName: "BlurFilter",
          templateId: "blur",
        },
      ],
      incomingTransforms: [{ id: " in ", type: "position", parameters: { x: 1 } }],
      colorLayers: [
        { color: "#112233" },
        { id: " flash ", color: "#ffffff", zIndexOffset: 2 },
      ],
      zOrder: "sideways" as ExtensionTransitionZOrder,
    }));
    const { definition } = registerFx({ renderFrame });

    const frame = definition.renderFrame!(renderContext(BASE_PARAMETERS));

    expect(renderFrame.mock.calls[0][0]).toMatchObject({
      parameters: BASE_PARAMETERS,
      schemaVersion: 2,
      progress: 0.25,
      transition: { id: "transition-render", startTicks: 0, endTicks: 100, durationTicks: 100 },
      frame: { projectWidth: 1920, projectHeight: 1080, fps: 30, presentationTimeTicks: 25 },
    });
    expect(frame).toEqual({
      outgoingTransforms: [
        {
          id: "transition-render:extension:outgoing:0",
          type: "filter",
          isEnabled: false,
          parameters: { strength: 0.25 },
          templateId: "blur",
          filterName: "BlurFilter",
        },
      ],
      incomingTransforms: [
        {
          id: "transition-render:extension:incoming:in",
          type: "position",
          isEnabled: true,
          parameters: { x: 1 },
        },
      ],
      colorLayers: [
        { id: "transition-render:extension:color:0", color: "#112233", zIndexOffset: undefined },
        { id: "transition-render:extension:color:flash", color: "#ffffff", zIndexOffset: 2 },
      ],
      zOrder: undefined,
    });
  });

  it.each([
    ["non-JSON transform parameters", { outgoingTransforms: [{ type: "x", parameters: { bad: Infinity } }] }],
    ["blank transform type", { incomingTransforms: [{ type: " ", parameters: {} }] }],
    ["bad color", { colorLayers: [{ color: "white" }] }],
    ["bad z offset", { colorLayers: [{ color: "#000000", zIndexOffset: Number.NaN }] }],
  ])("drops frames with %s", (_label, output) => {
    const { definition, scope } = registerFx({
      renderFrame: () => output as ExtensionTransitionFrame,
    });
    expect(definition.renderFrame!(renderContext(BASE_PARAMETERS))).toEqual({});
    expect(scope.report).toHaveBeenCalledWith(
      "error",
      "Transition 'example.fx/fx' returned invalid frame output.",
      expect.any(Error),
    );
  });

  it("reports renderer exceptions and invalid parameters once per transition", () => {
    const { definition, scope } = registerFx({
      renderFrame: () => {
        throw new Error("render failed");
      },
    });

    expect(definition.renderFrame!(renderContext(BASE_PARAMETERS))).toEqual({});
    expect(definition.renderFrame!(renderContext(BASE_PARAMETERS))).toEqual({});
    expect(scope.report).toHaveBeenCalledTimes(1);

    const invalid = renderContext({ ...BASE_PARAMETERS, amount: 99 });
    expect(definition.renderFrame!(invalid)).toEqual({});
    expect(scope.report).toHaveBeenLastCalledWith(
      "error",
      "Transition 'example.fx/fx' received invalid parameters.",
      undefined,
    );
  });

  it("defaults a missing schema version to the definition's", () => {
    const renderFrame = vi.fn(() => ({}));
    const { definition } = registerFx({ renderFrame });
    definition.renderFrame!(renderContext(BASE_PARAMETERS, undefined));
    expect(renderFrame).toHaveBeenCalledTimes(1);
  });

  it("migrates older parameters at render time without a stored rewrite", () => {
    const renderFrame = vi.fn(() => ({}));
    const migrateParameters = vi.fn(
      (parameters: Readonly<Record<string, unknown>>) => ({
        schemaVersion: 2,
        parameters: { ...BASE_PARAMETERS, amount: Number(parameters.legacy) },
      }),
    );
    const { definition } = registerFx({ renderFrame, migrateParameters });
    const legacy = { legacy: 2 };

    definition.renderFrame!(renderContext(legacy, 1));

    expect(migrateParameters).toHaveBeenCalledWith(legacy, 1);
    expect(renderFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        parameters: { ...BASE_PARAMETERS, amount: 2 },
      }),
    );
    expect(legacy).toEqual({ legacy: 2 });
  });

  it.each([
    ["no migrator", undefined],
    [
      "a wrong target version",
      () => ({ schemaVersion: 3, parameters: BASE_PARAMETERS }),
    ],
    [
      "invalid migrated parameters",
      () => ({ schemaVersion: 2, parameters: { ...BASE_PARAMETERS, mode: "z" } }),
    ],
    [
      "a throwing migrator",
      () => {
        throw new Error("migrate failed");
      },
    ],
  ])("fails closed when migrating with %s", (_label, migrateParameters) => {
    const renderFrame = vi.fn(() => ({}));
    const { definition, scope } = registerFx({
      renderFrame,
      migrateParameters:
        migrateParameters as ExtensionTransitionDefinition["migrateParameters"],
    });
    expect(definition.renderFrame!(renderContext({ legacy: 1 }, 1))).toEqual({});
    expect(renderFrame).not.toHaveBeenCalled();
    expect(scope.report).toHaveBeenCalled();
  });

  it("notifies subscribers as registrations change", () => {
    const registry = new ExtensionTransitionRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const before = registry.getRevision();

    const registration = registry
      .bind(createScope("example.fx"))
      .register(definitionWith());
    registration.dispose();

    expect(registry.getRevision()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
