import { describe, expect, it, vi } from "vitest";
import { ExtensionTransformationRegistry } from "../ExtensionTransformationRegistry";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionTransformationControl,
} from "../../../extensions";

function createScope(extensionId = "example.tools"): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function register(
  registry: ExtensionTransformationRegistry,
  controls: readonly ExtensionTransformationControl[],
  scope = createScope(),
) {
  return registry.bind(scope).register({
    id: "tool",
    apiVersion: 1,
    kind: "trusted-filter",
    label: "Tool",
    groups: [{ id: "tool", title: "Tool", controls }],
    createFilter: () => ({ object: {}, update: () => undefined }),
  });
}

const exposure: ExtensionTransformationControl = {
  type: "slider",
  name: "exposure",
  label: "Exposure",
  defaultValue: 0,
  min: -5,
  max: 5,
};

describe("extension custom controls", () => {
  it("is UI-only: it never becomes a persisted parameter or a default", () => {
    const registry = new ExtensionTransformationRegistry();
    register(registry, [
      exposure,
      {
        type: "custom",
        name: "_editor",
        label: "Editor",
        componentId: "editor",
      },
    ]);

    const definition = registry.listDefinitions()[0]!;
    expect(Object.keys(definition.defaultParameters ?? {})).toEqual(["exposure"]);
    // A grade written with only the real parameter must still validate.
    expect(definition.extension?.validateParameters?.({ exposure: 1 })).toBe(true);
  });

  it("owner-qualifies the component ID", () => {
    const registry = new ExtensionTransformationRegistry();
    register(registry, [
      exposure,
      { type: "custom", name: "_editor", label: "Editor", componentId: "editor" },
    ]);

    const control = registry
      .listDefinitions()[0]!
      .uiConfig.groups[0]!.controls.find((item) => item.type === "custom")!;
    expect(control.componentId).toBe("example.tools/editor");
  });

  it("refuses an already-qualified ID, so one extension cannot mount another's component", () => {
    const registry = new ExtensionTransformationRegistry();
    expect(() =>
      register(registry, [
        exposure,
        {
          type: "custom",
          name: "_editor",
          label: "Editor",
          componentId: "other.ext/editor",
        },
      ]),
    ).toThrow(/panel control registered by this extension/i);
  });

  it("defaults the commit allowlist to the transformation's own parameters", () => {
    const registry = new ExtensionTransformationRegistry();
    register(registry, [
      exposure,
      { type: "custom", name: "_editor", label: "Editor", componentId: "editor" },
    ]);

    const control = registry
      .listDefinitions()[0]!
      .uiConfig.groups[0]!.controls.find((item) => item.type === "custom")!;
    expect(control.parameterNames).toEqual(["exposure"]);
  });

  it("rejects an allowlist naming a parameter the transformation does not declare", () => {
    const registry = new ExtensionTransformationRegistry();
    expect(() =>
      register(registry, [
        exposure,
        {
          type: "custom",
          name: "_editor",
          label: "Editor",
          componentId: "editor",
          parameterNames: ["saturation"],
        },
      ]),
    ).toThrow(/cannot commit unknown parameter 'saturation'/i);
  });

  it("resolves an allowlist for a control declared before the parameter it edits", () => {
    const registry = new ExtensionTransformationRegistry();
    register(registry, [
      {
        type: "custom",
        name: "_editor",
        label: "Editor",
        componentId: "editor",
        parameterNames: ["exposure"],
      },
      exposure,
    ]);

    const control = registry
      .listDefinitions()[0]!
      .uiConfig.groups[0]!.controls.find((item) => item.type === "custom")!;
    expect(control.parameterNames).toEqual(["exposure"]);
  });

  it("rejects a custom control on a declarative host filter", () => {
    const registry = new ExtensionTransformationRegistry();
    expect(() =>
      registry.bind(createScope()).register({
        id: "declarative",
        apiVersion: 1,
        kind: "host-filter",
        hostFilter: "hsl-adjustment",
        label: "Declarative",
        groups: [
          {
            id: "grade",
            title: "Grade",
            controls: [
              {
                type: "custom",
                name: "_editor",
                label: "Editor",
                componentId: "editor",
              },
            ],
          },
        ],
      }),
    ).toThrow(/cannot use a custom control/i);
  });
});
