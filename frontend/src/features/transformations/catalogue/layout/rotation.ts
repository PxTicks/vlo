/**
 * rotation.ts
 *
 * Rotation transformation handler.
 * The TransformationDefinition is now in layoutDefinition.ts.
 */

import { resolveScalar } from "../../utils/resolveScalar";
import type {
  TransformHandler,
  TransformState,
  TransformContext,
} from "../types";
import type { RotationTransform } from "../../types";
import { TemplateRegistry } from "./templates";

export const rotationHandler: TransformHandler<RotationTransform> = (
  state: TransformState,
  transform: RotationTransform,
  context: TransformContext,
) => {
  // 1. Template Override
  if (transform.templateId && TemplateRegistry[transform.templateId]) {
    const template = TemplateRegistry[transform.templateId];
    const templateParams = template(context);
    if (templateParams.rotation !== undefined)
      state.rotation = templateParams.rotation;
  }

  // 2. Additive Parameters
  const { angle } = transform.parameters;
  const t = context.time ?? 0;

  state.rotation += resolveScalar(angle, t, 0);
};
