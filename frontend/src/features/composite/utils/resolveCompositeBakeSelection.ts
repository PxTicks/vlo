import type { Asset } from "../../../types/Asset";
import type { CompositeAsset } from "../../../types/TimelineTypes";
import {
  resolveCompositeBakeValidity,
  type CompositeBakeValidity,
} from "./compositeBakeValidity";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
  type CompositeRenderDimensions,
} from "./compositeRenderContract";

export interface ResolveCompositeBakeSelectionOptions {
  composite: CompositeAsset;
  assets: readonly Asset[];
  logicalDimensions: CompositeRenderDimensions;
  projectFps: number;
}

export interface CompositeBakeSelection {
  expectedBakeKey: string;
  validity: CompositeBakeValidity;
}

/**
 * Resolves the canonical current bake independently of a placement's cached
 * asset pointer. Playback and timeline thumbnails both use this decision so
 * undo/redo cannot resurrect a stale `composite-live:` or old-bake source.
 */
export function resolveCompositeBakeSelection(
  options: ResolveCompositeBakeSelectionOptions,
): CompositeBakeSelection {
  const expectedBakeKey = serializeCompositeBakeKey(
    createCompositeBakeKey({
      content: options.composite.content,
      projectFps: options.projectFps,
      logicalDimensions: options.logicalDimensions,
      assets: options.assets,
    }),
  );
  return {
    expectedBakeKey,
    validity: resolveCompositeBakeValidity({
      composite: options.composite,
      expectedBakeKey,
      availableAssetIds: new Set(options.assets.map((asset) => asset.id)),
    }),
  };
}
