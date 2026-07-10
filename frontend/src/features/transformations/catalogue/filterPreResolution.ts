import type { FilterOperation } from "./types";
import { COLOR_GRADE_FILTER_NAME } from "./filters/colorGrade/definition";

export const FUSED_COLOR_GRADE_LAYERS_PARAMETER = "grades";

export interface ResolvedColorGradeLayer {
  readonly transformId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface FusedColorGradeParameters {
  readonly grades: readonly ResolvedColorGradeLayer[];
}

function isColorGradeOperation(operation: FilterOperation): boolean {
  return operation.type === COLOR_GRADE_FILTER_NAME;
}

/**
 * Collapse each contiguous Color Grade run into one runtime operation.
 * Non-grade filters remain ordering barriers. Effect-masked rendering resolves
 * one authored transform per offscreen step, so each masked grade naturally
 * forms its own run and cannot be fused across its composite boundary.
 */
export function preResolveFilterOperations(
  operations: readonly FilterOperation[],
): FilterOperation[] {
  const resolved: FilterOperation[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!isColorGradeOperation(operation)) {
      resolved.push(operation);
      continue;
    }

    const grades: ResolvedColorGradeLayer[] = [];
    let runEnd = index;
    while (
      runEnd < operations.length &&
      isColorGradeOperation(operations[runEnd])
    ) {
      const grade = operations[runEnd];
      grades.push({
        transformId: grade.sourceTransformId ?? `unbound-grade-${runEnd}`,
        parameters: grade.params,
      });
      runEnd += 1;
    }

    resolved.push({
      type: COLOR_GRADE_FILTER_NAME,
      params: { [FUSED_COLOR_GRADE_LAYERS_PARAMETER]: grades },
      sourceTransformId: grades[0]?.transformId,
    });
    index = runEnd - 1;
  }

  return resolved;
}
