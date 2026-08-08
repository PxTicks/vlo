import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostScopeRegistry, type ScopeRenderTarget } from "../../../scopes";
import { createExtensionScopeApi } from "../createExtensionScopeApi";

function createScope(extensionId = "example.a") {
  const controller = new AbortController();
  const resources: ExtensionResource[] = [];
  const report = vi.fn();
  const scope: ExtensionApiScope = {
    extension: { id: extensionId, version: "1.0.0" },
    signal: controller.signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report,
  };
  return {
    scope,
    report,
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
  };
}

const DEFINITION = {
  id: "false-color",
  apiVersion: 1 as const,
  kind: "trusted-scope" as const,
  label: "False Colour",
  width: 64,
  height: 32,
  render: () => undefined,
};

function target(): ScopeRenderTarget {
  return {
    context: {} as CanvasRenderingContext2D,
    width: 64,
    height: 32,
    frame: {
      pixels: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
      sampledAt: 0,
    },
  };
}

describe("createExtensionScopeApi", () => {
  it("qualifies the ID with the owning extension", () => {
    const registry = new HostScopeRegistry();
    const harness = createScope();
    const registration = createExtensionScopeApi(harness.scope, registry).register(
      DEFINITION,
    );

    expect(registration.id).toBe("example.a/false-color");
    expect(registry.get("example.a/false-color")).toMatchObject({
      label: "False Colour",
      source: "extension",
      // An unstated order sorts after the host's own scopes.
      order: 1_000,
    });
  });

  it("removes the scope on deactivation and on explicit disposal", async () => {
    const registry = new HostScopeRegistry();
    const harness = createScope();
    const api = createExtensionScopeApi(harness.scope, registry);

    const first = api.register(DEFINITION);
    first.dispose();
    expect(registry.list()).toEqual([]);

    api.register(DEFINITION);
    expect(registry.list()).toHaveLength(1);
    await harness.dispose();
    expect(registry.list()).toEqual([]);
  });

  it("rejects a malformed definition before it reaches the registry", () => {
    const registry = new HostScopeRegistry();
    const api = createExtensionScopeApi(createScope().scope, registry);

    expect(() => api.register({ ...DEFINITION, apiVersion: 2 as never })).toThrow(
      /trusted-scope API 1/,
    );
    expect(() => api.register({ ...DEFINITION, id: "Bad Id" })).toThrow(
      /Invalid scope ID/,
    );
    expect(() =>
      api.register({ ...DEFINITION, render: undefined as never }),
    ).toThrow(/must provide render/);
    // Surface bounds are the registry's rule, not the adapter's.
    expect(() => api.register({ ...DEFINITION, width: 4 })).toThrow(
      /width must be an integer between/,
    );
    expect(registry.list()).toEqual([]);
  });

  it("reports a throwing render once, then again after it recovers", () => {
    const registry = new HostScopeRegistry();
    const harness = createScope();
    let shouldThrow = true;
    createExtensionScopeApi(harness.scope, registry).register({
      ...DEFINITION,
      render: () => {
        if (shouldThrow) throw new Error("bad draw");
      },
    });
    const entry = registry.get("example.a/false-color");

    entry?.render(target());
    entry?.render(target());
    entry?.render(target());
    // Deduplicated: the sampler runs several times a second and would
    // otherwise bury the activation diagnostics it shares a buffer with.
    expect(harness.report).toHaveBeenCalledTimes(1);

    shouldThrow = false;
    entry?.render(target());
    shouldThrow = true;
    entry?.render(target());
    // A scope that recovered and broke again is news.
    expect(harness.report).toHaveBeenCalledTimes(2);
  });

  it("leaves nothing registered when ownership is refused", () => {
    const registry = new HostScopeRegistry();
    const scope: ExtensionApiScope = {
      extension: { id: "example.a", version: "1.0.0" },
      signal: new AbortController().signal,
      own: () => {
        throw new Error("registration closed");
      },
      report: vi.fn(),
    };

    expect(() =>
      createExtensionScopeApi(scope, registry).register(DEFINITION),
    ).toThrow(/registration closed/);
    expect(registry.list()).toEqual([]);
  });
});
