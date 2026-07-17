import { describe, expect, it } from "vitest";
import type { CompositeBakeValidity } from "../../../../composite";
import {
  createCompositeSourcePolicySnapshot,
  resolveCompositeSourceDecision,
} from "../CompositeSourcePolicy";

const validBake: CompositeBakeValidity = {
  valid: true,
  assetId: "bake",
  bakeKey: "key",
  compositeRevision: 2,
};

describe("CompositeSourcePolicy", () => {
  it("selects a matching valid bake in automatic mode", () => {
    expect(
      resolveCompositeSourceDecision({
        compositeId: "composite",
        placementAssetId: "bake",
        validity: validBake,
      }),
    ).toEqual({ mode: "baked", fallbackReason: null, bakeAssetId: "bake" });
  });

  it("keeps live content when placement relinking has not committed", () => {
    expect(
      resolveCompositeSourceDecision({
        compositeId: "composite",
        placementAssetId: "old-bake",
        validity: validBake,
      }),
    ).toEqual({
      mode: "live",
      fallbackReason: "placement-not-relinked",
      bakeAssetId: null,
    });
  });

  it("honours a pinned force-live preference without exposing a bake fallback", () => {
    const policy = createCompositeSourcePolicySnapshot({
      forceLiveCompositeIds: new Set(["composite"]),
    });

    expect(
      resolveCompositeSourceDecision({
        compositeId: "composite",
        placementAssetId: "bake",
        validity: validBake,
        policy,
      }),
    ).toEqual({
      mode: "live",
      fallbackReason: "forced-live",
      bakeAssetId: null,
    });
  });

  it("does not use a stale bake even when force-baked is requested", () => {
    const policy = createCompositeSourcePolicySnapshot({
      forceBakedCompositeIds: new Set(["composite"]),
    });

    expect(
      resolveCompositeSourceDecision({
        compositeId: "composite",
        placementAssetId: "bake",
        validity: {
          valid: false,
          reason: "stale-key",
          compositeRevision: 2,
        },
        policy,
      }),
    ).toEqual({
      mode: "live",
      fallbackReason: "forced-bake-unavailable",
      bakeAssetId: null,
    });
  });

  it("copies preferences so an export snapshot cannot change mid-render", () => {
    const forceLiveCompositeIds = new Set<string>();
    const policy = createCompositeSourcePolicySnapshot({
      forceLiveCompositeIds,
    });
    forceLiveCompositeIds.add("composite");

    expect(
      resolveCompositeSourceDecision({
        compositeId: "composite",
        placementAssetId: "bake",
        validity: validBake,
        policy,
      }).mode,
    ).toBe("baked");
  });
});
