import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { ExtensionPeerRegistry } from "../ExtensionPeerRegistry";

function scopeFor(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function seed(registry: ExtensionPeerRegistry): void {
  registry.declarePackage({
    id: "example.provider",
    version: "1.2.0",
    dependencies: {},
  });
  registry.declarePackage({
    id: "example.consumer",
    version: "1.0.0",
    dependencies: { "example.provider": ">=1.2.0 <2.0.0" },
  });
}

describe("ExtensionPeerRegistry", () => {
  it("reports a declared dependency before and after it publishes", () => {
    const registry = new ExtensionPeerRegistry();
    seed(registry);
    const api = registry.bind(scopeFor("example.consumer"));

    expect(api.listDependencies()).toEqual([
      {
        id: "example.provider",
        version: "1.2.0",
        versionRange: ">=1.2.0 <2.0.0",
        isActive: false,
        hasApi: false,
      },
    ]);

    registry.publishApi("example.provider", { apiVersion: 1 });
    expect(api.listDependencies()[0]).toMatchObject({
      isActive: true,
      hasApi: true,
    });
    expect(api.getApi("example.provider")).toEqual({ apiVersion: 1 });
  });

  it("throws for a peer the manifest did not declare", () => {
    const registry = new ExtensionPeerRegistry();
    seed(registry);
    registry.publishApi("example.provider", { apiVersion: 1 });
    // The provider is installed, active, and exporting — the only thing wrong
    // is that nobody declared the relationship, which is a manifest bug.
    const api = registry.bind(scopeFor("example.provider"));
    expect(() => api.getApi("example.consumer")).toThrow(/did not declare/);
    expect(() => api.requireApi("example.consumer")).toThrow(/did not declare/);
    expect(() => api.getApi("")).toThrow(TypeError);
  });

  it("distinguishes an inactive peer from one that exports nothing", () => {
    const registry = new ExtensionPeerRegistry();
    seed(registry);
    const api = registry.bind(scopeFor("example.consumer"));

    expect(api.getApi("example.provider")).toBeUndefined();
    expect(() => api.requireApi("example.provider")).toThrow(/not active/);

    registry.markActive("example.provider");
    expect(() => api.requireApi("example.provider")).toThrow(
      /active but exports nothing/,
    );
  });

  it("retracts an export so a deactivated peer stops answering", () => {
    const registry = new ExtensionPeerRegistry();
    seed(registry);
    const api = registry.bind(scopeFor("example.consumer"));
    registry.publishApi("example.provider", { apiVersion: 1 });

    registry.retract("example.provider");
    expect(api.getApi("example.provider")).toBeUndefined();
    expect(api.listDependencies()[0]).toMatchObject({
      isActive: false,
      hasApi: false,
    });
  });

  it("keeps declarations and exports independent", () => {
    const registry = new ExtensionPeerRegistry();
    seed(registry);
    registry.publishApi("example.provider", { apiVersion: 1 });

    // Re-reading the inventory replaces the declaration; the running
    // activation's export belongs to the activation, not to the manifest.
    registry.declarePackage({
      id: "example.provider",
      version: "1.3.0",
      dependencies: {},
    });
    expect(registry.getApi("example.provider")).toEqual({ apiVersion: 1 });
    expect(registry.getDeclaration("example.provider")?.version).toBe("1.3.0");
  });

  it("freezes the dependency map it hands back", () => {
    const registry = new ExtensionPeerRegistry();
    const dependencies = { "example.provider": ">=1.0.0" };
    registry.declarePackage({
      id: "example.consumer",
      version: "1.0.0",
      dependencies,
    });
    dependencies["example.provider"] = ">=9.0.0";
    expect(
      registry.getDeclaration("example.consumer")?.dependencies,
    ).toEqual({ "example.provider": ">=1.0.0" });
  });

  it("drops a declaration on disposal without touching its neighbours", () => {
    const registry = new ExtensionPeerRegistry();
    const registration = registry.declarePackage({
      id: "example.provider",
      version: "1.2.0",
      dependencies: {},
    });
    registry.declarePackage({
      id: "example.consumer",
      version: "1.0.0",
      dependencies: {},
    });

    registration.dispose();
    registration.dispose();
    expect(registry.getDeclaration("example.provider")).toBeUndefined();
    expect(registry.getDeclaration("example.consumer")).toBeDefined();
  });
});
