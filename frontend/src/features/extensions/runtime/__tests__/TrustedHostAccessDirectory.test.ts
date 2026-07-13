import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { TrustedHostAccessDirectory } from "../TrustedHostAccessDirectory";

function createScope(owned: ExtensionResource[] = []): ExtensionApiScope {
  return {
    extension: { id: "example.trusted", version: "1.0.0" },
    signal: new AbortController().signal,
    own: (resource) => {
      owned.push(resource);
      return resource;
    },
    report: vi.fn(),
  };
}

describe("TrustedHostAccessDirectory", () => {
  it("returns exact live identity and exposes availability changes", () => {
    const directory = new TrustedHostAccessDirectory();
    const first = { name: "first" };
    const second = { name: "second" };
    let current: object | undefined;
    directory.register({
      id: "renderer.runtime",
      lifetime: "availability",
      getValue: () => current,
      assertValue: (value) => typeof value === "object" && value !== null,
    });
    const listener = vi.fn();
    directory.subscribe(listener);
    const initialRevision = directory.getRevision();

    expect(directory.list()).toEqual([
      { id: "renderer.runtime", available: false, lifetime: "availability" },
    ]);
    current = first;
    directory.notifyAvailabilityChanged();
    expect(directory.get("renderer.runtime")).toBe(first);
    current = second;
    directory.notifyAvailabilityChanged();
    expect(directory.get("renderer.runtime")).toBe(second);
    expect(directory.getRevision()).toBe(initialRevision + 2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("labels missing required entries and reports trusted use once", () => {
    const directory = new TrustedHostAccessDirectory();
    const scope = createScope();
    const api = directory.bind(scope, "0.2.0");

    expect(api.get("missing.entry")).toBeUndefined();
    expect(() => api.require("missing.entry")).toThrow(
      "[Extension example.trusted]",
    );
    expect(scope.report).toHaveBeenCalledWith(
      "debug",
      "Trusted host access used.",
      { hostVersion: "0.2.0" },
    );
    expect(
      vi.mocked(scope.report).mock.calls.filter(([level]) => level === "debug"),
    ).toHaveLength(1);
  });

  it("isolates a drifted entry from discovery and optional lookup", () => {
    const directory = new TrustedHostAccessDirectory();
    const scope = createScope();
    const stableValue = { stable: true };
    directory.register({
      id: "stable.entry",
      lifetime: "session",
      getValue: () => stableValue,
      assertValue: () => true,
    });
    directory.register({
      id: "drifted.entry",
      lifetime: "session",
      getValue: () => ({ detached: true }),
      assertValue: () => false,
    });
    const api = directory.bind(scope, "0.2.0");

    expect(api.list()).toEqual([
      { id: "stable.entry", available: true, lifetime: "session" },
      { id: "drifted.entry", available: false, lifetime: "session" },
    ]);
    expect(api.get("stable.entry")).toBe(stableValue);
    expect(api.get("drifted.entry")).toBeUndefined();
    expect(scope.report).toHaveBeenCalledWith(
      "error",
      "Trusted host entry 'drifted.entry' failed its host shape assertion.",
      expect.any(TypeError),
    );
    expect(() => api.require("drifted.entry")).toThrow(
      "[Extension example.trusted] Trusted host entry 'drifted.entry' failed its host shape assertion.",
    );
  });

  it("keeps discovery non-throwing when a provider or assertion throws", () => {
    const directory = new TrustedHostAccessDirectory();
    directory.register({
      id: "provider.failure",
      lifetime: "session",
      getValue: () => {
        throw new Error("provider drift");
      },
      assertValue: () => true,
    });
    directory.register({
      id: "assertion.failure",
      lifetime: "session",
      getValue: () => ({}),
      assertValue: () => {
        throw new Error("assertion drift");
      },
    });

    expect(directory.list()).toEqual([
      { id: "provider.failure", available: false, lifetime: "session" },
      { id: "assertion.failure", available: false, lifetime: "session" },
    ]);
    expect(directory.get("provider.failure")).toBeUndefined();
    expect(directory.get("assertion.failure")).toBeUndefined();
  });
});
