import type { CompositeAsset } from "../../../types/TimelineTypes";

export type CompositeBakeInvalidReason =
  | "missing-metadata"
  | "not-ready"
  | "missing-ready-key"
  | "stale-key"
  | "stale-revision"
  | "missing-asset";

export interface ResolveCompositeBakeValidityOptions {
  composite: CompositeAsset;
  expectedBakeKey: string;
  availableAssetIds: ReadonlySet<string>;
}

export type CompositeBakeValidity =
  | {
      valid: true;
      assetId: string;
      bakeKey: string;
      compositeRevision: number;
    }
  | {
      valid: false;
      reason: CompositeBakeInvalidReason;
      compositeRevision: number;
      assetId?: string;
      readyKey?: string;
    };

/** Legacy composite documents predate revision identity and resolve as v1. */
export function resolveCompositeRevision(composite: CompositeAsset): number {
  const revision = composite.revision;
  if (
    typeof revision === "number" &&
    Number.isInteger(revision) &&
    revision > 0
  ) {
    return revision;
  }
  return 1;
}

/**
 * The sole bake-cache freshness decision. The legacy `bakedAssetId` is
 * deliberately not sufficient: it remains usable by the old playback path,
 * but cannot become a direct-render cache without a matching key and revision.
 */
export function resolveCompositeBakeValidity(
  options: ResolveCompositeBakeValidityOptions,
): CompositeBakeValidity {
  const compositeRevision = resolveCompositeRevision(options.composite);
  const bake = options.composite.bake;

  if (!bake) {
    return { valid: false, reason: "missing-metadata", compositeRevision };
  }

  if (bake.status !== "ready") {
    return {
      valid: false,
      reason: "not-ready",
      compositeRevision,
      ...(bake.assetId ? { assetId: bake.assetId } : {}),
      ...(bake.readyKey ? { readyKey: bake.readyKey } : {}),
    };
  }

  if (!bake.readyKey) {
    return {
      valid: false,
      reason: "missing-ready-key",
      compositeRevision,
      ...(bake.assetId ? { assetId: bake.assetId } : {}),
    };
  }

  if (bake.readyKey !== options.expectedBakeKey) {
    return {
      valid: false,
      reason: "stale-key",
      compositeRevision,
      ...(bake.assetId ? { assetId: bake.assetId } : {}),
      readyKey: bake.readyKey,
    };
  }

  if (bake.readyRevision !== compositeRevision) {
    return {
      valid: false,
      reason: "stale-revision",
      compositeRevision,
      ...(bake.assetId ? { assetId: bake.assetId } : {}),
      readyKey: bake.readyKey,
    };
  }

  if (!bake.assetId || !options.availableAssetIds.has(bake.assetId)) {
    return {
      valid: false,
      reason: "missing-asset",
      compositeRevision,
      ...(bake.assetId ? { assetId: bake.assetId } : {}),
      readyKey: bake.readyKey,
    };
  }

  return {
    valid: true,
    assetId: bake.assetId,
    bakeKey: bake.readyKey,
    compositeRevision,
  };
}
