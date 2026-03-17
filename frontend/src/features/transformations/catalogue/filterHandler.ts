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
import type { GenericFilterTransform } from "../types";
import { resolveScalar } from "../utils/resolveScalar";
import { isSplineParameter } from "../utils/typeGuards";

/**
 * Handler for generic filter transformations.
 * Resolves parameter values (including splines) and pushes to the filters stack.
 */
export const filterHandler: TransformHandler<GenericFilterTransform> = (
  state: TransformState,
  transform: GenericFilterTransform,
  context: TransformContext,
) => {
  // Resolve parameters (handle splines)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolvedParams: any = {};
  const t = context.time ?? 0;

  for (const [key, value] of Object.entries(transform.parameters)) {
    if (typeof value === "number") {
      resolvedParams[key] = value;
      continue;
    }

    if (typeof value === "boolean") {
      resolvedParams[key] = value;
      continue;
    }

    if (isSplineParameter(value)) {
      resolvedParams[key] = resolveScalar(value, t, 0);
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

    resolvedParams[key] = resolveScalar(undefined, t, 0);
  }

  // Push the generic op to the stack
  state.filters.push({
    type: transform.filterName,
    params: resolvedParams,
  });
};
