import type { CompositeBakeValidity } from "../../../composite";

export type CompositeSourcePreference =
  | "automatic"
  | "force-live"
  | "force-baked";

export type CompositeSourceFallbackReason =
  | "forced-live"
  | "forced-bake-unavailable"
  | Exclude<CompositeBakeValidity, { valid: true }>["reason"];

export interface CompositeSourcePolicySnapshot {
  readonly preferenceByCompositeId: ReadonlyMap<
    string,
    CompositeSourcePreference
  >;
}

export interface CompositeSourceDecision {
  mode: "live" | "baked";
  fallbackReason: CompositeSourceFallbackReason | null;
  bakeAssetId: string | null;
}

export function createCompositeSourcePolicySnapshot(options: {
  forceLiveCompositeIds?: ReadonlySet<string>;
  forceBakedCompositeIds?: ReadonlySet<string>;
} = {}): CompositeSourcePolicySnapshot {
  const preferenceByCompositeId = new Map<
    string,
    CompositeSourcePreference
  >();
  for (const compositeId of options.forceBakedCompositeIds ?? []) {
    preferenceByCompositeId.set(compositeId, "force-baked");
  }
  for (const compositeId of options.forceLiveCompositeIds ?? []) {
    preferenceByCompositeId.set(compositeId, "force-live");
  }
  return { preferenceByCompositeId };
}

export function resolveCompositeSourceDecision(options: {
  compositeId: string;
  validity: CompositeBakeValidity;
  policy?: CompositeSourcePolicySnapshot;
}): CompositeSourceDecision {
  const preference =
    options.policy?.preferenceByCompositeId.get(options.compositeId) ??
    "automatic";

  if (preference === "force-live") {
    return {
      mode: "live",
      fallbackReason: "forced-live",
      bakeAssetId: null,
    };
  }

  if (options.validity.valid) {
    return {
      mode: "baked",
      fallbackReason: null,
      bakeAssetId: options.validity.assetId,
    };
  }

  return {
    mode: "live",
    fallbackReason:
      preference === "force-baked"
        ? "forced-bake-unavailable"
        : options.validity.reason,
    bakeAssetId: null,
  };
}
