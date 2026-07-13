/**
 * Generic Filter Handler
 *
 * This handler is in a separate file to avoid circular dependencies.
 * It does NOT depend on the TransformationRegistry, so filter definitions
 * can safely import it.
 */

import type {
  TransformHandler,
  TransformState,
  TransformContext,
} from "./types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isSplineParameter,
  type GenericFilterTransform,
  type ScalarParameter,
} from "../types";
import { resolveScalar } from "../utils/resolveScalar";

export function isResolvableTransformationScalar(
  value: unknown,
): value is ScalarParameter {
  return (
    typeof value === "number" ||
    isSplineParameter(value) ||
    isExtensionScalarSourceParameter(value) ||
    isExtensionKeyframedScalarParameter(value)
  );
}

export function resolveTransformationParameters(
  parameters: Readonly<Record<string, unknown>>,
  time: number,
): Record<string, unknown> {
  const resolvedParams: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "number") {
      resolvedParams[key] = value;
      continue;
    }

    if (typeof value === "boolean") {
      resolvedParams[key] = value;
      continue;
    }

    if (typeof value === "string" || value === null) {
      resolvedParams[key] = value;
      continue;
    }

    if (isResolvableTransformationScalar(value)) {
      resolvedParams[key] = resolveScalar(value, time, 0);
      continue;
    }

    if (Array.isArray(value)) {
      resolvedParams[key] = [...value];
      continue;
    }

    if (value && typeof value === "object") {
      resolvedParams[key] = { ...value };
      continue;
    }

    resolvedParams[key] = resolveScalar(undefined, time, 0);
  }

  return resolvedParams;
}

/**
 * Handler for generic filter transformations.
 * Resolves parameter values (including splines) and pushes to the filters stack.
 */
export const filterHandler: TransformHandler<GenericFilterTransform> = (
  state: TransformState,
  transform: GenericFilterTransform,
  context: TransformContext,
) => {
  const resolvedParams = resolveTransformationParameters(
    transform.parameters,
    context.time ?? 0,
  );

  // Push the generic op to the stack
  state.filters.push({
    type: transform.filterName,
    params: resolvedParams,
    sourceTransformId: transform.id,
  });
};
