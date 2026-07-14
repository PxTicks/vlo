import { describe, expect, it, vi } from "vitest";
import { ExtensionLutRegistry } from "../ExtensionLutRegistry";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function projection(
  packageDigest: string,
  luts: readonly { id: string; order: number }[],
) {
  return {
    ownerId: "example.looks",
    packageVersion: "1.0.0",
    packageDigest,
    luts: luts.map(({ id, order }) => ({
      id,
      label: id.toUpperCase(),
      order,
      resourceUrl: `/resources/${id}.cube`,
    })),
  };
}

describe("ExtensionLutRegistry", () => {
  it("owner-qualifies, orders, and removes projected package LUTs", () => {
    const registry = new ExtensionLutRegistry();

    expect(
      registry.reconcilePackages([
        projection(DIGEST_A, [
          { id: "second", order: 20 },
          { id: "first", order: 10 },
        ]),
      ]),
    ).toEqual([]);
    expect(registry.list().map((entry) => entry.id)).toEqual([
      "example.looks/first",
      "example.looks/second",
    ]);

    registry.reconcilePackages([]);
    expect(registry.list()).toEqual([]);
  });

  it("replaces one package atomically and emits one revision", () => {
    const registry = new ExtensionLutRegistry();
    registry.reconcilePackages([
      projection(DIGEST_A, [{ id: "old", order: 0 }]),
    ]);
    const snapshots: string[][] = [];
    const unsubscribe = registry.subscribe(() => {
      snapshots.push(registry.list().map((entry) => entry.id));
    });

    registry.reconcilePackages([
      projection(DIGEST_B, [
        { id: "new-a", order: 0 },
        { id: "new-b", order: 1 },
      ]),
    ]);

    expect(snapshots).toEqual([
      ["example.looks/new-a", "example.looks/new-b"],
    ]);
    unsubscribe();
  });

  it("fails a malformed replacement closed without exposing a partial set", () => {
    const registry = new ExtensionLutRegistry();
    registry.reconcilePackages([
      projection(DIGEST_A, [{ id: "old", order: 0 }]),
    ]);
    const listener = vi.fn();
    registry.subscribe(listener);

    const failures = registry.reconcilePackages([
      projection(DIGEST_B, [
        { id: "duplicate", order: 0 },
        { id: "duplicate", order: 1 },
      ]),
    ]);

    expect(failures).toHaveLength(1);
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not re-register an unchanged package digest", () => {
    const registry = new ExtensionLutRegistry();
    const packageProjection = projection(DIGEST_A, [
      { id: "stable", order: 0 },
    ]);
    registry.reconcilePackages([packageProjection]);
    const revision = registry.getRevision();

    registry.reconcilePackages([packageProjection]);

    expect(registry.getRevision()).toBe(revision);
  });
});
