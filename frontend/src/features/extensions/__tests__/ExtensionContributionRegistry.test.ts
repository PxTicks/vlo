import { describe, expect, it, vi } from "vitest";
import {
  DuplicateExtensionContributionError,
  ExtensionContributionRegistry,
  InvalidExtensionContributionIdError,
  type BoundExtensionContributionRegistry,
  type ExtensionApiScope,
  type ExtensionContributionDefinition,
  type ExtensionResource,
} from "..";

interface TestContribution extends ExtensionContributionDefinition {
  label: string;
}

function bindRegistry(
  registry: ExtensionContributionRegistry<TestContribution>,
  ownerId: string,
): {
  registrar: BoundExtensionContributionRegistry<TestContribution>;
  owned: ExtensionResource[];
} {
  const owned: ExtensionResource[] = [];
  const scope: ExtensionApiScope = {
    extension: { id: ownerId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: (resource) => {
      owned.push(resource);
      return resource;
    },
    report: () => undefined,
  };
  return { registrar: registry.bind(scope), owned };
}

describe("ExtensionContributionRegistry", () => {
  it("namespaces contributions by their host-supplied owner", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );

    bindRegistry(registry, "example.alpha").registrar.register({
      id: "shared-name",
      apiVersion: 1,
      label: "Alpha",
    });
    bindRegistry(registry, "example.beta").registrar.register({
      id: "shared-name",
      apiVersion: 1,
      label: "Beta",
    });

    expect(registry.list().map((entry) => entry.id)).toEqual([
      "example.alpha/shared-name",
      "example.beta/shared-name",
    ]);
    expect(registry.listByOwner("example.beta")[0]?.definition.label).toBe(
      "Beta",
    );
  });

  it("rejects duplicate IDs within one owner and registry", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );
    const definition: TestContribution = {
      id: "duplicate",
      apiVersion: 1,
      label: "Duplicate",
    };

    const { registrar } = bindRegistry(registry, "example.owner");
    registrar.register(definition);

    expect(() => registrar.register(definition)).toThrow(
      DuplicateExtensionContributionError,
    );
  });

  it("returns an idempotent disposer that releases the ID", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );
    const definition: TestContribution = {
      id: "temporary",
      apiVersion: 1,
      label: "Temporary",
    };
    const { registrar } = bindRegistry(registry, "example.owner");
    const registration = registrar.register(definition);

    registration.dispose();
    registration.dispose();

    expect(registry.has("example.owner/temporary")).toBe(false);
    expect(() => registrar.register(definition)).not.toThrow();
  });

  it("rejects unsafe IDs and invalid API versions", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );

    expect(() =>
      bindRegistry(registry, "example/escape").registrar.register({
        id: "safe",
        apiVersion: 1,
        label: "Unsafe owner",
      }),
    ).toThrow(InvalidExtensionContributionIdError);
    expect(() =>
      bindRegistry(registry, "example.owner").registrar.register({
        id: "../escape",
        apiVersion: 1,
        label: "Unsafe contribution",
      }),
    ).toThrow(InvalidExtensionContributionIdError);
    expect(() =>
      bindRegistry(registry, "example.owner").registrar.register({
        id: "invalid-version",
        apiVersion: 0,
        label: "Invalid version",
      }),
    ).toThrow(/positive integer apiVersion/);
  });

  it("stores a shallow-frozen definition snapshot", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );
    const definition: TestContribution = {
      id: "snapshot",
      apiVersion: 1,
      label: "Before",
    };

    const registration = bindRegistry(
      registry,
      "example.owner",
    ).registrar.register(definition);
    definition.label = "After";

    expect(registration.contribution.definition.label).toBe("Before");
    expect(Object.isFrozen(registration.contribution.definition)).toBe(true);
  });

  it("automatically enrolls registrations with the activation scope", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );
    const { registrar, owned } = bindRegistry(registry, "example.owner");

    const registration = registrar.register({
      id: "owned",
      apiVersion: 1,
      label: "Owned",
    });

    expect(owned).toEqual([registration]);
    expect(registration.contribution.ownerId).toBe("example.owner");
  });

  it("notifies derived registry consumers on registration and disposal", () => {
    const registry = new ExtensionContributionRegistry<TestContribution>(
      "test.registry",
    );
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const registration = bindRegistry(
      registry,
      "example.owner",
    ).registrar.register({
      id: "reactive",
      apiVersion: 1,
      label: "Reactive",
    });

    expect(registry.getRevision()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    registration.dispose();
    expect(registry.getRevision()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    bindRegistry(registry, "example.owner").registrar.register({
      id: "silent",
      apiVersion: 1,
      label: "Silent",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
