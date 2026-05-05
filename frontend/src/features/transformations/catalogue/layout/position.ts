/**
 * position.ts
 *
 * Position transformation handler.
 * The TransformationDefinition is now in layoutDefinition.ts.
 */

import { resolveScalar } from "../../utils/resolveScalar";
import type {
  TransformHandler,
  TransformState,
  TransformContext,
} from "../types";
import type { PositionTransform } from "../../types";
import { TemplateRegistry } from "./templates";
import { samplePositionPath } from "../../utils/positionPath";

export const positionHandler: TransformHandler<PositionTransform> = (
  state: TransformState,
  transform: PositionTransform,
  context: TransformContext,
) => {
  // 1. Template Override (if present)
  if (transform.templateId && TemplateRegistry[transform.templateId]) {
    const template = TemplateRegistry[transform.templateId];
    const templateParams = template(context);
    if (templateParams.x !== undefined) state.x = templateParams.x;
    if (templateParams.y !== undefined) state.y = templateParams.y;
  }

  // 2. Additive Parameters
  const { x, y, path } = transform.parameters;
  const t = context.time ?? 0;

  if (path) {
    const sampledPoint = samplePositionPath(
      path,
      context.visualTime ?? t,
      context.visualDuration ?? 0,
    );
    state.x += sampledPoint.x;
    state.y += sampledPoint.y;
    return;
  }

  state.x += resolveScalar(x, t, 0);
  state.y += resolveScalar(y, t, 0);
};
