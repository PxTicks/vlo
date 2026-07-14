import { describe, expect, it, vi } from "vitest";
import { ExtensionParameterPresetRegistry } from "../registry/ExtensionParameterPresetRegistry";
import type { ExtensionApiScope } from "../types";

const GRADE_TARGET = { kind: "filter", filterName: "ColorGradeFilter" } as const;

function createScope(id = "example.grading-tools"): {
  scope: ExtensionApiScope;
  owned: { dispose(): void | Promise<void> }[];
} {
  const owned: { dispose(): void | Promise<void> }[] = [];
  const scope = {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <T,>(resource: T): T => {
      owned.push(resource as { dispose(): void });
      return resource;
    },
    report: vi.fn(),
  } as unknown as ExtensionApiScope;
  return { scope, owned };
}

function disposeAll(owned: { dispose(): void | Promise<void> }[]): void {
  for (const resource of [...owned].reverse()) void resource.dispose();
}

function registerLook(
  registry: ExtensionParameterPresetRegistry,
  scope: ExtensionApiScope,
  overrides: Partial<Parameters<
    ReturnType<ExtensionParameterPresetRegistry["bind"]>["register"]
  >[0]> = {},
) {
  return registry.bind(scope).register({
    id: "warm-look",
    apiVersion: 1,
    label: "Warm look",
    target: GRADE_TARGET,
    parameters: { temperature: 12, saturation: 1.05 },
    ...overrides,
  });
}

describe("ExtensionParameterPresetRegistry", () => {
  it("owner-qualifies the preset and lists it against its target", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope, owned } = createScope();

    const registration = registerLook(registry, scope);

    expect(registration.id).toBe("example.grading-tools/warm-look");
    const [preset] = registry.list(GRADE_TARGET);
    expect(preset.definition.label).toBe("Warm look");
    expect(preset.definition.parameters).toEqual({
      temperature: 12,
      saturation: 1.05,
    });

    disposeAll(owned);
    expect(registry.list(GRADE_TARGET)).toHaveLength(0);
  });

  it("normalizes and clamps only the fields the patch carries", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope } = createScope();

    registerLook(registry, scope, {
      parameters: { lutIntensity: 4, saturation: 0.5 },
    });

    const [preset] = registry.list(GRADE_TARGET);
    expect(preset.definition.parameters).toEqual({
      lutIntensity: 1,
      saturation: 0.5,
    });
    expect(Object.isFrozen(preset.definition.parameters)).toBe(true);
  });

  it("rejects an unsupported target", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope } = createScope();

    expect(() =>
      registerLook(registry, scope, {
        target: { kind: "filter", filterName: "BlurFilter" },
      }),
    ).toThrow(/unsupported transformation/i);
  });

  it("rejects lutAssetId, which no extension package can know", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope } = createScope();

    expect(() =>
      registerLook(registry, scope, {
        parameters: { saturation: 0.9, lutAssetId: "asset-1" },
      }),
    ).toThrow(/lutAssetId/);
  });

  it("rejects animated values, unknown fields, and empty patches", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope } = createScope();

    expect(() =>
      registerLook(registry, scope, {
        parameters: {
          exposure: {
            type: "spline",
            points: [{ time: 0, value: 0 }],
          },
        },
      }),
    ).toThrow(/animated/i);
    expect(() =>
      registerLook(registry, scope, { parameters: { _gradeManagement: 1 } }),
    ).toThrow(/unknown grade parameter/i);
    expect(() => registerLook(registry, scope, { parameters: {} })).toThrow(
      /at least one parameter/i,
    );
    expect(registry.list(GRADE_TARGET)).toHaveLength(0);
  });

  it("rejects a duplicate qualified ID and reports a revision per change", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const { scope } = createScope();
    const listener = vi.fn();
    registry.subscribe(listener);

    registerLook(registry, scope);
    expect(() => registerLook(registry, scope)).toThrow(/already registered/i);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getRevision()).toBe(1);
  });

  it("orders presets by order, then by qualified ID", () => {
    const registry = new ExtensionParameterPresetRegistry();
    const first = createScope("example.a");
    const second = createScope("example.b");

    registerLook(registry, second.scope, { id: "late", order: 5 });
    registerLook(registry, second.scope, { id: "look" });
    registerLook(registry, first.scope, { id: "look" });

    expect(registry.list(GRADE_TARGET).map((preset) => preset.id)).toEqual([
      "example.a/look",
      "example.b/look",
      "example.b/late",
    ]);
  });
});
