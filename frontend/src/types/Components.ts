/**
 * Component: a typed attachment carried on a StandardTimelineClip.
 *
 * Every component has a discriminator `type`, a stable `id`, and a typed
 * `parameters` payload. Variants can optionally embed references to
 * subordinate clips (via ids inside their parameters) — the base schema
 * stays agnostic to that concern so third-party extensions only pay for
 * what they need.
 */

import type { ClipTransform, MaskBooleanExpression } from "./TimelineTypes";

export interface ComponentBase<TType extends string, TParams> {
  id: string;
  type: TType;
  /** Defaults to true when absent. */
  isEnabled?: boolean;
  parameters: TParams;
}

// ---------------------------------------------------------------------------
// range_mask: source-time window of transparency
// ---------------------------------------------------------------------------

export interface RangeMaskComponentParameters {
  startSourceTicks: number;
  endSourceTicks: number;
  isActive: boolean;
  name?: string;
}

export type RangeMaskComponent = ComponentBase<
  "range_mask",
  RangeMaskComponentParameters
>;

// ---------------------------------------------------------------------------
// mask_ref: reference to a subordinate MaskTimelineClip
// ---------------------------------------------------------------------------

export interface MaskRefComponentParameters {
  maskClipId: string;
}

export type MaskRefComponent = ComponentBase<
  "mask_ref",
  MaskRefComponentParameters
>;

// ---------------------------------------------------------------------------
// mask_composition: how child masks are composited on this parent clip
// ---------------------------------------------------------------------------

export type MaskCompositionAlgebra = "normal" | "inverse";

export const DEFAULT_MASK_COMPOSITION_ALGEBRA: MaskCompositionAlgebra =
  "inverse";

export interface MaskCompositionComponentParameters {
  /**
   * Tri-state:
   *  - absent: legacy auto-union over child masks
   *  - null:   user explicitly disabled composed masking
   *  - object: explicit boolean expression
   */
  expression?: MaskBooleanExpression | null;
  /**
   * Controls whether boolean operations are evaluated in ordinary coverage
   * space or in inverse/"hole" coverage space.
   */
  algebra?: MaskCompositionAlgebra;
  /** Post-composition edge operations (grow, feather). */
  compositeTransformations: ClipTransform[];
}

export function resolveMaskCompositionAlgebra(
  parameters:
    | Pick<MaskCompositionComponentParameters, "algebra">
    | null
    | undefined,
): MaskCompositionAlgebra {
  return parameters?.algebra ?? DEFAULT_MASK_COMPOSITION_ALGEBRA;
}

export function usesInverseMaskCompositionAlgebra(
  parameters:
    | Pick<MaskCompositionComponentParameters, "algebra">
    | null
    | undefined,
): boolean {
  return resolveMaskCompositionAlgebra(parameters) === "inverse";
}

export type MaskCompositionComponent = ComponentBase<
  "mask_composition",
  MaskCompositionComponentParameters
>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type Component =
  | RangeMaskComponent
  | MaskRefComponent
  | MaskCompositionComponent;

export type ComponentType = Component["type"];

export function isComponentOfType<T extends ComponentType>(
  component: Component,
  type: T,
): component is Extract<Component, { type: T }> {
  return component.type === type;
}
