/**
 * scale.ts
 *
 * Scale transformation handler.
 * The TransformationDefinition is now in layoutDefinition.ts.
 */

import { resolveScalar } from "../../utils/resolveScalar";
import type {
  TransformHandler,
  TransformState,
  TransformContext,
} from "../types";
import type { ScaleTransform } from "../../types";
import { TemplateRegistry } from "./templates";

export const scaleHandler: TransformHandler<ScaleTransform> = (
  state: TransformState,
  transform: ScaleTransform,
  context: TransformContext,
) => {
  // 1. Template Override
  if (transform.templateId && TemplateRegistry[transform.templateId]) {
    const template = TemplateRegistry[transform.templateId];
    const templateParams = template(context);
    if (templateParams.scaleX !== undefined)
      state.scaleX = templateParams.scaleX;
    if (templateParams.scaleY !== undefined)
      state.scaleY = templateParams.scaleY;
  }

  // 2. Multiplicative Parameters
  const { x, y } = transform.parameters;
  const t = context.time ?? 0;

  state.scaleX *= resolveScalar(x, t, 1);
  state.scaleY *= resolveScalar(y, t, 1);
};
