import { describe, expect, it } from "vitest";
import type { CompositeAsset } from "../../../../types/TimelineTypes";
import {
  resolveCompositeBakeValidity,
  resolveCompositeRevision,
} from "../compositeBakeValidity";

function composite(overrides: Partial<CompositeAsset> = {}): CompositeAsset {
  return {
    id: "composite-1",
    name: "Composite",
    content: { clips: [], durationTicks: 100 },
    revision: 3,
    bake: {
      status: "ready",
      requestedKey: "key-current",
      readyKey: "key-current",
      readyRevision: 3,
      assetId: "bake-1",
      updatedAt: 10,
    },
    bakedAssetId: "bake-1",
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function resolve(value: CompositeAsset, expectedBakeKey = "key-current") {
  return resolveCompositeBakeValidity({
    composite: value,
    expectedBakeKey,
    availableAssetIds: new Set(["bake-1"]),
  });
}

describe("resolveCompositeBakeValidity", () => {
  it("accepts only a ready key, revision, and available asset", () => {
    expect(resolve(composite())).toEqual({
      valid: true,
      assetId: "bake-1",
      bakeKey: "key-current",
      compositeRevision: 3,
    });
  });

  it("treats legacy revision and missing metadata deterministically", () => {
    const legacy = composite({ revision: undefined, bake: undefined });
    expect(resolveCompositeRevision(legacy)).toBe(1);
    expect(resolve(legacy)).toEqual({
      valid: false,
      reason: "missing-metadata",
      compositeRevision: 1,
    });
  });

  it.each([
    ["none", "not-ready"],
    ["queued", "not-ready"],
    ["rendering", "not-ready"],
    ["failed", "not-ready"],
  ] as const)("rejects %s bake state", (status, reason) => {
    expect(resolve(composite({ bake: { status } }))).toMatchObject({
      valid: false,
      reason,
    });
  });

  it("rejects migrated legacy metadata without a complete key", () => {
    expect(
      resolve(
        composite({
          bake: {
            status: "ready",
            readyRevision: 3,
            assetId: "bake-1",
          },
        }),
      ),
    ).toMatchObject({ valid: false, reason: "missing-ready-key" });
  });

  it("invalidates any changed expected bake key", () => {
    expect(
      resolve(composite(), "key-after-content-or-contract-change"),
    ).toMatchObject({
      valid: false,
      reason: "stale-key",
      readyKey: "key-current",
    });
  });

  it("rejects a matching key rendered from an older content revision", () => {
    expect(
      resolve(
        composite({
          revision: 4,
          bake: {
            status: "ready",
            readyKey: "key-current",
            readyRevision: 3,
            assetId: "bake-1",
          },
        }),
      ),
    ).toMatchObject({ valid: false, reason: "stale-revision" });
  });

  it("rejects absent and unavailable assets", () => {
    expect(
      resolve(
        composite({
          bake: {
            status: "ready",
            readyKey: "key-current",
            readyRevision: 3,
          },
        }),
      ),
    ).toMatchObject({ valid: false, reason: "missing-asset" });

    expect(
      resolveCompositeBakeValidity({
        composite: composite(),
        expectedBakeKey: "key-current",
        availableAssetIds: new Set(),
      }),
    ).toMatchObject({ valid: false, reason: "missing-asset" });
  });
});
