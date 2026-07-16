import {
  applyTransformStack,
  type ApplyTransformStackContext,
  type ApplyTransformStackOptions,
} from "./applyTransformations";
import { getEntryForTransform } from "./catalogue/TransformationRegistry";
import type { ClipTransform } from "../../types/TimelineTypes";
import type { FilterOperation } from "./catalogue/types";

/**
 * A resolved filter operation — one entry of `TransformState.filters`: the
 * filter name plus its time-sampled parameters, ready to instantiate a Pixi
 * filter. This is what the offscreen masked-effect path applies per filter.
 */
export type ResolvedFilterOp = FilterOperation;

export interface ResolvedFilterOpLookup {
  readonly lookup: Map<ClipTransform, ResolvedFilterOp>;
  readonly sourceTimeTicks: number;
}

/**
 * Resolve each enabled filter transform to its time-sampled filter op.
 *
 * Runs the shared transform stack ONCE (so speed-pass source-time anchoring and
 * live-preview overrides are applied exactly as the live `sprite.filters` path)
 * and pairs the resulting ordered `state.filters` with the enabled filter
 * transforms in stack order. This is sound because `filterHandler` pushes
 * exactly one op per filter transform and no other handler writes to
 * `state.filters`; calling `applyTransformStack` directly (not
 * `applyClipTransforms`) also avoids the range-mask AlphaFilter injection.
 *
 * A filter whose `filterName` doesn't resolve in the registry (unknown/stale)
 * dispatches to no handler and emits NO op, so it is skipped WITHOUT consuming
 * one — otherwise the next valid op would be mis-paired onto the unknown
 * transform. Such filters are simply absent from the map; the renderer must
 * treat a missing op as "contributes nothing".
 *
 * The returned map is keyed by the transform instance, so the offscreen
 * renderer can look up each `planTransformRender` step's op.
 */
export function buildResolvedFilterOpLookup(
  transformations: readonly ClipTransform[] | undefined,
  ctx: ApplyTransformStackContext,
  time?: number,
  options?: ApplyTransformStackOptions,
): Map<ClipTransform, ResolvedFilterOp> {
  return buildResolvedFilterOpLookupWithTime(
    transformations,
    ctx,
    time,
    options,
  ).lookup;
}

/**
 * Resolve filter operations together with the post-speed source tick used by
 * the same stack pass. The masked offscreen path needs both so temporal filters
 * receive timing equivalent to the ordinary on-container applicator.
 */
export function buildResolvedFilterOpLookupWithTime(
  transformations: readonly ClipTransform[] | undefined,
  ctx: ApplyTransformStackContext,
  time?: number,
  options?: ApplyTransformStackOptions,
): ResolvedFilterOpLookup {
  const lookup = new Map<ClipTransform, ResolvedFilterOp>();
  if (!transformations || transformations.length === 0) {
    return { lookup, sourceTimeTicks: time ?? 0 };
  }

  const { state, sourceTimeTicks } = applyTransformStack(
    transformations,
    ctx,
    time,
    {
      ...options,
      // Pure resolution — never fire live-param notifications as a side effect.
      notifyLiveParams: false,
    },
  );

  let opIndex = 0;
  for (const transform of transformations) {
    if (!transform.isEnabled || transform.type !== "filter") {
      continue;
    }
    // Unknown/stale filters dispatch to no handler and push no op (same
    // resolution the dispatch uses). Skip them WITHOUT advancing opIndex, so
    // valid ops stay paired with their own transforms.
    if (!getEntryForTransform(transform)) {
      continue;
    }
    const op = state.filters[opIndex];
    opIndex += 1;
    if (op) {
      lookup.set(transform, op);
    }
  }
  return { lookup, sourceTimeTicks };
}
