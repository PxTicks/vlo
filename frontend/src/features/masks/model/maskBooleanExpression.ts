import type {
  MaskBooleanExpression,
  MaskBooleanOperationExpression,
  MaskBooleanOperator,
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../types/TimelineTypes";

const MASK_CLIP_ID_SEPARATOR = "::mask::";
const MASK_BOOLEAN_OPERATOR_ORDER: MaskBooleanOperator[] = [
  "union",
  "intersect",
  "subtract",
];

export type MaskBooleanExpressionPath = Array<"left" | "right">;

export interface MaskBooleanExpressionAnalysis {
  maskIds: string[];
  operationCount: number;
}

function areExpressionPathsEqual(
  left: MaskBooleanExpressionPath,
  right: MaskBooleanExpressionPath,
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function foldMaskExpressions(
  expressions: readonly MaskBooleanExpression[],
  operator: MaskBooleanOperator,
): MaskBooleanExpression | null {
  if (expressions.length === 0) {
    return null;
  }

  return expressions.reduce<MaskBooleanExpression | null>((current, expression) => {
    if (!current) {
      return structuredClone(expression);
    }

    return {
      kind: "operation",
      operator,
      left: current,
      right: structuredClone(expression),
    };
  }, null);
}

function filterMaskBooleanExpression(
  expression: MaskBooleanExpression,
  predicate: (maskId: string) => boolean,
): MaskBooleanExpression | null {
  if (expression.kind === "mask_ref") {
    return predicate(expression.maskId) ? expression : null;
  }

  const left = filterMaskBooleanExpression(expression.left, predicate);
  const right = filterMaskBooleanExpression(expression.right, predicate);

  if (!left && !right) {
    return null;
  }

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  if (left === expression.left && right === expression.right) {
    return expression;
  }

  if (left && right) {
    return {
      kind: "operation",
      operator: expression.operator,
      left,
      right,
    };
  }

  return null;
}

export function createMaskBooleanMaskRef(maskId: string): MaskBooleanExpression {
  return {
    kind: "mask_ref",
    maskId,
  };
}

export function appendMaskBooleanExpression(
  expression: MaskBooleanExpression | null | undefined,
  maskId: string,
  operator: MaskBooleanOperator = "union",
): MaskBooleanExpression {
  const maskRef = createMaskBooleanMaskRef(maskId);
  if (!expression) {
    return maskRef;
  }

  return {
    kind: "operation",
    operator,
    left: structuredClone(expression),
    right: maskRef,
  };
}

export function cycleMaskBooleanOperator(
  operator: MaskBooleanOperator,
): MaskBooleanOperator {
  const currentIndex = MASK_BOOLEAN_OPERATOR_ORDER.indexOf(operator);
  if (currentIndex < 0) {
    return "union";
  }

  return MASK_BOOLEAN_OPERATOR_ORDER[
    (currentIndex + 1) % MASK_BOOLEAN_OPERATOR_ORDER.length
  ];
}

export function getMaskLocalIdFromMaskClipId(maskClipId: string): string | null {
  const idx = maskClipId.indexOf(MASK_CLIP_ID_SEPARATOR);
  if (idx <= 0) {
    return null;
  }

  const maskId = maskClipId.slice(idx + MASK_CLIP_ID_SEPARATOR.length);
  return maskId || null;
}

export function getMaskLocalId(
  maskClip: Pick<MaskTimelineClip, "id">,
): string | null {
  return getMaskLocalIdFromMaskClipId(maskClip.id);
}

export function collectMaskBooleanExpressionMaskIds(
  expression: MaskBooleanExpression | null | undefined,
): string[] {
  return analyzeMaskBooleanExpression(expression).maskIds;
}

export function countMaskBooleanOperationNodes(
  expression: MaskBooleanExpression | null | undefined,
): number {
  return analyzeMaskBooleanExpression(expression).operationCount;
}

export function analyzeMaskBooleanExpression(
  expression: MaskBooleanExpression | null | undefined,
): MaskBooleanExpressionAnalysis {
  if (!expression || expression.kind !== "operation") {
    return {
      maskIds:
        expression?.kind === "mask_ref" ? [expression.maskId] : [],
      operationCount: 0,
    };
  }

  const maskIds = new Set<string>();
  let operationCount = 0;

  const visit = (node: MaskBooleanExpression) => {
    if (node.kind === "mask_ref") {
      maskIds.add(node.maskId);
      return;
    }

    operationCount += 1;
    visit(node.left);
    visit(node.right);
  };

  visit(expression);

  return {
    maskIds: [...maskIds],
    operationCount,
  };
}

export function sanitizeMaskBooleanExpression(
  expression: MaskBooleanExpression,
  availableMaskIds: Iterable<string>,
): MaskBooleanExpression | null {
  const availableMaskIdSet = new Set(availableMaskIds);
  return filterMaskBooleanExpression(
    expression,
    (maskId) => availableMaskIdSet.has(maskId),
  );
}

export function pruneMaskBooleanExpression(
  expression: MaskBooleanExpression,
  removedMaskIds: Iterable<string>,
): MaskBooleanExpression | null {
  const removedMaskIdSet = new Set(removedMaskIds);
  return filterMaskBooleanExpression(
    expression,
    (maskId) => !removedMaskIdSet.has(maskId),
  );
}

export function resolveLegacyMaskBooleanExpression(
  maskClips: readonly MaskTimelineClip[],
): MaskBooleanExpression | null {
  const regularMasks: MaskBooleanExpression[] = [];
  const invertedMasks: MaskBooleanExpression[] = [];

  maskClips.forEach((maskClip) => {
    if (maskClip.maskMode !== "apply") {
      return;
    }

    const maskId = getMaskLocalId(maskClip);
    if (!maskId) {
      return;
    }

    const maskRef = createMaskBooleanMaskRef(maskId);
    if (maskClip.maskInverted) {
      invertedMasks.push(maskRef);
      return;
    }

    regularMasks.push(maskRef);
  });

  const regularExpression = foldMaskExpressions(regularMasks, "union");
  if (regularExpression) {
    return invertedMasks.reduce<MaskBooleanExpression>(
      (current, invertedExpression) => ({
        kind: "operation",
        operator: "intersect",
        left: current,
        right: structuredClone(invertedExpression),
      }),
      regularExpression,
    );
  }

  return foldMaskExpressions(invertedMasks, "intersect");
}

export function resolveMaskBooleanExpression(
  parentClip: Pick<StandardTimelineClip, "maskBooleanExpression">,
  maskClips: readonly MaskTimelineClip[],
): MaskBooleanExpression | null {
  if (parentClip.maskBooleanExpression === null) {
    return null;
  }

  if (parentClip.maskBooleanExpression !== undefined) {
    const availableMaskIds = maskClips
      .map((maskClip) => getMaskLocalId(maskClip))
      .filter((maskId): maskId is string => !!maskId);
    return sanitizeMaskBooleanExpression(
      parentClip.maskBooleanExpression,
      availableMaskIds,
    );
  }

  return resolveLegacyMaskBooleanExpression(maskClips);
}

export function resolveRenderableMaskBooleanExpression(
  parentClip: Pick<StandardTimelineClip, "maskBooleanExpression">,
  maskClips: readonly MaskTimelineClip[],
): MaskBooleanExpression | null {
  const resolvedExpression = resolveMaskBooleanExpression(parentClip, maskClips);
  if (!resolvedExpression) {
    return null;
  }

  const offMaskIds = maskClips
    .filter((maskClip) => maskClip.maskMode === "off")
    .map((maskClip) => getMaskLocalId(maskClip))
    .filter((maskId): maskId is string => !!maskId);
  if (offMaskIds.length === 0) {
    return resolvedExpression;
  }

  return pruneMaskBooleanExpression(resolvedExpression, offMaskIds);
}

export function getMaskBooleanExpressionAtPath(
  expression: MaskBooleanExpression | null | undefined,
  path: MaskBooleanExpressionPath,
): MaskBooleanExpression | null {
  if (!expression) {
    return null;
  }

  let current: MaskBooleanExpression = expression;
  for (const segment of path) {
    if (current.kind !== "operation") {
      return null;
    }
    current = current[segment];
  }

  return current;
}

function updateMaskBooleanExpressionAtPath(
  expression: MaskBooleanExpression,
  path: MaskBooleanExpressionPath,
  updater: (node: MaskBooleanExpression) => MaskBooleanExpression | null,
): MaskBooleanExpression | null {
  if (path.length === 0) {
    return updater(expression);
  }

  if (expression.kind !== "operation") {
    return structuredClone(expression);
  }

  const [segment, ...rest] = path;
  const siblingSegment = segment === "left" ? "right" : "left";
  const updatedChild = updateMaskBooleanExpressionAtPath(
    expression[segment],
    rest,
    updater,
  );

  if (!updatedChild) {
    return structuredClone(expression[siblingSegment]);
  }

  return {
    kind: "operation",
    operator: expression.operator,
    left:
      segment === "left"
        ? updatedChild
        : structuredClone(expression.left),
    right:
      segment === "right"
        ? updatedChild
        : structuredClone(expression.right),
  };
}

export function replaceMaskBooleanExpressionAtPath(
  expression: MaskBooleanExpression,
  path: MaskBooleanExpressionPath,
  replacement: MaskBooleanExpression,
): MaskBooleanExpression {
  return (
    updateMaskBooleanExpressionAtPath(
      expression,
      path,
      () => structuredClone(replacement),
    ) ?? structuredClone(replacement)
  );
}

export function removeMaskBooleanExpressionAtPath(
  expression: MaskBooleanExpression,
  path: MaskBooleanExpressionPath,
): MaskBooleanExpression | null {
  return updateMaskBooleanExpressionAtPath(expression, path, () => null);
}

export function setMaskBooleanExpressionOperatorAtPath(
  expression: MaskBooleanExpression,
  path: MaskBooleanExpressionPath,
  operator: MaskBooleanOperator,
): MaskBooleanExpression {
  return (
    updateMaskBooleanExpressionAtPath(expression, path, (node) => {
      if (node.kind !== "operation") {
        return structuredClone(node);
      }

      return {
        kind: "operation",
        operator,
        left: structuredClone(node.left),
        right: structuredClone(node.right),
      };
    }) ?? structuredClone(expression)
  );
}

export function swapMaskBooleanExpressionOperandsAtPath(
  expression: MaskBooleanExpression,
  path: MaskBooleanExpressionPath,
): MaskBooleanExpression {
  return (
    updateMaskBooleanExpressionAtPath(expression, path, (node) => {
      if (node.kind !== "operation") {
        return structuredClone(node);
      }

      return {
        kind: "operation",
        operator: node.operator,
        left: structuredClone(node.right),
        right: structuredClone(node.left),
      };
    }) ?? structuredClone(expression)
  );
}

export function swapMaskBooleanExpressionNodes(
  expression: MaskBooleanExpression,
  firstPath: MaskBooleanExpressionPath,
  secondPath: MaskBooleanExpressionPath,
): MaskBooleanExpression {
  if (areExpressionPathsEqual(firstPath, secondPath)) {
    return structuredClone(expression);
  }

  const firstNode = getMaskBooleanExpressionAtPath(expression, firstPath);
  const secondNode = getMaskBooleanExpressionAtPath(expression, secondPath);
  if (!firstNode || !secondNode) {
    return structuredClone(expression);
  }

  const swapNodes = (
    node: MaskBooleanExpression,
    path: MaskBooleanExpressionPath,
  ): MaskBooleanExpression => {
    if (areExpressionPathsEqual(path, firstPath)) {
      return structuredClone(secondNode);
    }

    if (areExpressionPathsEqual(path, secondPath)) {
      return structuredClone(firstNode);
    }

    if (node.kind !== "operation") {
      return structuredClone(node);
    }

    return {
      kind: "operation",
      operator: node.operator,
      left: swapNodes(node.left, [...path, "left"]),
      right: swapNodes(node.right, [...path, "right"]),
    };
  };

  return swapNodes(expression, []);
}

export function collectUnionMaskIds(
  expression: MaskBooleanExpression | null | undefined,
): string[] | null {
  if (!expression) {
    return null;
  }

  if (expression.kind === "mask_ref") {
    return [expression.maskId];
  }

  if (expression.operator !== "union") {
    return null;
  }

  const left = collectUnionMaskIds(expression.left);
  const right = collectUnionMaskIds(expression.right);
  if (!left || !right) {
    return null;
  }

  return [...left, ...right];
}

export function isMaskBooleanOperationExpression(
  expression: MaskBooleanExpression | null | undefined,
): expression is MaskBooleanOperationExpression {
  return !!expression && expression.kind === "operation";
}
