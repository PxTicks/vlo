/**
 * skew.ts
 *
 * Skew transformation handler.
 * The TransformationDefinition is in layoutDefinition.ts.
 */

import { resolveScalar } from "../../utils/resolveScalar";
import type {
  TransformHandler,
  TransformState,
  TransformContext,
} from "../types";
import type { SkewTransform } from "../../types";

export const skewHandler: TransformHandler<SkewTransform> = (
  state: TransformState,
  transform: SkewTransform,
  context: TransformContext,
) => {
  // Additive, like rotation; layout templates never set skew.
  const { x, y } = transform.parameters;
  const t = context.time ?? 0;

  state.skewX = (state.skewX ?? 0) + resolveScalar(x, t, 0);
  state.skewY = (state.skewY ?? 0) + resolveScalar(y, t, 0);
};
