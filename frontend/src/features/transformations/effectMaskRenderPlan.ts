import type {
  ClipTransform,
  MaskBooleanExpression,
} from "../../types/TimelineTypes";

/**
 * How a single filter transform's effect mask resolves for rendering.
 *
 * - `unmasked`: apply the filter to the whole texture (legacy behaviour).
 * - `masked`: apply the filter to the full texture, then reveal that output
 *   through the mask alpha (`out = mix(input, effectOutput, maskAlpha)`).
 * - `empty`: an enabled mask with no usable expression — the filter contributes
 *   nothing. Crucially NOT "apply to the whole clip", so a broken/empty mask
 *   never silently blurs/colours the entire clip.
 */
export type EffectMaskResolution =
  | { kind: "unmasked" }
  | { kind: "masked"; expression: MaskBooleanExpression }
  | { kind: "empty" };

/** An ordered filter operation in an offscreen render plan. */
export interface FilterRenderStep {
  transform: ClipTransform;
  resolution: EffectMaskResolution;
}

/**
 * The render strategy for a clip's transform stack.
 *
 * - `legacy`: no enabled filter carries an active effect mask, so the whole
 *   stack runs the existing `applyClipTransforms` / `sprite.filters` path
 *   unchanged. Keeping unmasked-only chains here avoids any pixel drift from
 *   routing them through an offscreen pipeline.
 * - `offscreen`: at least one enabled filter has an active effect mask, so the
 *   filter sub-chain must run through the offscreen masked-effect pipeline in
 *   transform order. `steps` is every enabled filter, in order, tagged with how
 *   it composites. Non-filter transforms (layout, speed, blend, volume) are NOT
 *   here — they stay on their normal path (out of scope for v1 effect masking).
 */
export type TransformRenderPlan =
  | { mode: "legacy" }
  | { mode: "offscreen"; steps: FilterRenderStep[] };

/** Filter transforms are the only effect-maskable transforms in v1; the
 *  codebase models them as `type === "filter"` (see TransformationRegistry). */
function isFilterTransform(transform: ClipTransform): boolean {
  return transform.type === "filter";
}

/**
 * Resolve a single transform's effect mask against the v1 truth table.
 * (See {@link import("../../types/TimelineTypes").EffectMask}.)
 */
export function resolveEffectMask(
  transform: ClipTransform,
): EffectMaskResolution {
  const effectMask = transform.effectMask;
  if (!effectMask || !effectMask.enabled) {
    return { kind: "unmasked" };
  }
  if (!effectMask.expression) {
    return { kind: "empty" };
  }
  return { kind: "masked", expression: effectMask.expression };
}

/**
 * Decide how a clip's transform stack must render.
 *
 * Pure: it reads only the transform list (and so can be unit-tested without a
 * renderer). The offscreen GPU execution of the returned steps — applying each
 * filter and compositing the masked ones via `MaskTextureResolver` — is the
 * `MaskedEffectRenderer` integration step, not here.
 */
export function planTransformRender(
  transforms: readonly ClipTransform[] | undefined,
): TransformRenderPlan {
  if (!transforms || transforms.length === 0) {
    return { mode: "legacy" };
  }

  const steps: FilterRenderStep[] = [];
  let hasActiveEffectMask = false;

  for (const transform of transforms) {
    if (!transform.isEnabled || !isFilterTransform(transform)) {
      continue;
    }
    const resolution = resolveEffectMask(transform);
    if (resolution.kind !== "unmasked") {
      // `masked` or `empty` both mean an effect mask is active on this filter,
      // which the legacy whole-clip path cannot represent.
      hasActiveEffectMask = true;
    }
    steps.push({ transform, resolution });
  }

  if (!hasActiveEffectMask) {
    return { mode: "legacy" };
  }

  return { mode: "offscreen", steps };
}
