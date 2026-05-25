/**
 * Filter Applicator
 *
 * Applies the filter stack to a PixiJS sprite at render time.
 * The handler is in a separate file to avoid circular dependencies.
 */

import type { ClipTransformTarget, TransformState } from "./types";
import { getEntryByFilterName } from "./TransformationRegistry";
import { Filter } from "pixi.js";
import type {
  FilterParameterPointBinding,
  FilterParameterScaleMode,
} from "./types";

// Re-export handler for backwards compatibility
export { filterHandler } from "./filterHandler";

interface TransformMatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

interface ScaleContext {
  worldScale: { x: number; y: number };
  objectBounds: { minX: number; minY: number; width: number; height: number };
  padding: number;
  matrix?: TransformMatrixLike;
  textureSize: { width: number; height: number };
  anchor: { x: number; y: number };
}

function getObjectBounds(
  matrix: TransformMatrixLike | undefined,
  textureSize: { width: number; height: number },
  anchor: { x: number; y: number },
): ScaleContext["objectBounds"] {
  if (!matrix) {
    return {
      minX: 0,
      minY: 0,
      width: textureSize.width,
      height: textureSize.height,
    };
  }

  const minLocalX = -anchor.x * textureSize.width;
  const maxLocalX = (1 - anchor.x) * textureSize.width;
  const minLocalY = -anchor.y * textureSize.height;
  const maxLocalY = (1 - anchor.y) * textureSize.height;

  const corners = [
    { x: minLocalX, y: minLocalY },
    { x: maxLocalX, y: minLocalY },
    { x: minLocalX, y: maxLocalY },
    { x: maxLocalX, y: maxLocalY },
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    const x = matrix.a * corner.x + matrix.c * corner.y + matrix.tx;
    const y = matrix.b * corner.x + matrix.d * corner.y + matrix.ty;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function getScaleContext(
  target: ClipTransformTarget,
  padding: number = 0,
): ScaleContext {
  const targetAny = target as ClipTransformTarget & {
    getGlobalTransform?: (
      matrix?: unknown,
      skipUpdate?: boolean,
    ) => TransformMatrixLike;
    worldTransform?: TransformMatrixLike;
    texture?: { width: number; height: number };
    anchor?: { x: number; y: number };
  };

  const matrix =
    typeof targetAny.getGlobalTransform === "function"
      ? targetAny.getGlobalTransform(undefined, false)
      : targetAny.worldTransform;

  const scaleX = matrix ? Math.hypot(matrix.a, matrix.b) || 1 : 1;
  const scaleY = matrix ? Math.hypot(matrix.c, matrix.d) || 1 : 1;

  const texW = targetAny.texture?.width ?? 1;
  const texH = targetAny.texture?.height ?? 1;
  const anchor = {
    x: targetAny.anchor?.x ?? 0,
    y: targetAny.anchor?.y ?? 0,
  };
  const objectBounds = getObjectBounds(
    matrix,
    { width: texW, height: texH },
    anchor,
  );

  return {
    worldScale: { x: scaleX, y: scaleY },
    objectBounds,
    padding,
    matrix,
    textureSize: { width: texW, height: texH },
    anchor,
  };
}

function scaleFilterParamValue(
  value: unknown,
  mode: FilterParameterScaleMode,
  ctx: ScaleContext,
): unknown {
  if (typeof value !== "number") {
    return value;
  }

  switch (mode) {
    case "worldX":
      return value * ctx.worldScale.x;
    case "worldY":
      return value * ctx.worldScale.y;
    case "worldUniform":
      return value * ((ctx.worldScale.x + ctx.worldScale.y) / 2);
  }
}

function resolvePointBinding(
  params: Record<string, unknown>,
  binding: FilterParameterPointBinding,
  ctx: ScaleContext,
): { x: number; y: number } | null {
  const xValue = params[binding.x];
  const yValue = params[binding.y];

  if (typeof xValue !== "number" || typeof yValue !== "number") {
    return null;
  }

  const localX = (xValue - ctx.anchor.x) * ctx.textureSize.width;
  const localY = (yValue - ctx.anchor.y) * ctx.textureSize.height;

  const matrix = ctx.matrix;
  const worldX = matrix
    ? matrix.a * localX + matrix.c * localY + matrix.tx
    : localX;
  const worldY = matrix
    ? matrix.b * localX + matrix.d * localY + matrix.ty
    : localY;

  if (binding.space === "screenGlobal") {
    return { x: worldX, y: worldY };
  }

  return {
    x: ctx.padding + (worldX - ctx.objectBounds.minX),
    y: ctx.padding + (worldY - ctx.objectBounds.minY),
  };
}

function applyPointBindings(
  params: Record<string, unknown>,
  bindings: readonly FilterParameterPointBinding[] | undefined,
  target: ClipTransformTarget,
  padding: number = 0,
): Record<string, unknown> {
  if (!bindings || bindings.length === 0) {
    return params;
  }

  const ctx = getScaleContext(target, padding);
  const nextParams: Record<string, unknown> = { ...params };

  for (const binding of bindings) {
    const point = resolvePointBinding(nextParams, binding, ctx);
    if (!point) {
      continue;
    }
    nextParams[binding.x] = point.x;
    nextParams[binding.y] = point.y;
  }

  return nextParams;
}

function getScaledFilterParams(
  params: Record<string, unknown>,
  scaleConfig: Readonly<Record<string, FilterParameterScaleMode>> | undefined,
  target: ClipTransformTarget,
  padding: number = 0,
): Record<string, unknown> {
  if (!scaleConfig || Object.keys(scaleConfig).length === 0) {
    return params;
  }

  const ctx = getScaleContext(target, padding);
  const scaledParams: Record<string, unknown> = { ...params };

  for (const [key, mode] of Object.entries(scaleConfig)) {
    scaledParams[key] = scaleFilterParamValue(params[key], mode, ctx);
  }

  return scaledParams;
}

/**
 * Applicator that instantiates and configures PixiJS filters
 * based on the filter stack in TransformState.
 */
export const filterApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
) => {
  const mutableTarget = target as { filters?: Filter[] | null };
  const existingFilters = mutableTarget.filters || [];
  const newFilters: Filter[] = [];

  // Create a pool of available existing filters for reuse
  const pool = [...existingFilters];

  for (const filterOp of state.filters) {
    // 1. Look up entry in Registry
    const registryEntry = getEntryByFilterName(filterOp.type);
    if (!registryEntry || !registryEntry.FilterClass) {
      continue;
    }

    const FilterClass = registryEntry.FilterClass;

    // 2. Find reusable instance in pool
    const poolIndex = pool.findIndex((f) => f instanceof FilterClass);
    let filterInstance: Filter;

    if (poolIndex !== -1) {
      filterInstance = pool[poolIndex];
      pool.splice(poolIndex, 1);
    } else {
      filterInstance = new FilterClass();
    }

    // Disable viewport clipping for filters with spatial point bindings
    // so that the filter texture always covers the full sprite bounds.
    // Without this, uOutputFrame shifts when the sprite extends off-screen,
    // causing position-dependent effects to drift.
    if (registryEntry.filterParameterPoints) {
      filterInstance.clipToViewport = false;
    }

    // 3. Apply Parameters
    const preliminaryParams = getScaledFilterParams(
      filterOp.params,
      registryEntry.filterParameterScale,
      target,
    );
    const nextPadding = registryEntry.filterPadding?.(preliminaryParams) ?? 0;
    const params = getScaledFilterParams(
      filterOp.params,
      registryEntry.filterParameterScale,
      target,
      Number.isFinite(nextPadding) ? nextPadding : 0,
    );
    const resolvedParams = applyPointBindings(
      params,
      registryEntry.filterParameterPoints,
      target,
      Number.isFinite(nextPadding) ? nextPadding : 0,
    );
    for (const [key, value] of Object.entries(resolvedParams)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (filterInstance as any)[key] = value;
    }

    if (registryEntry.filterPadding) {
      if (Number.isFinite(nextPadding)) {
        filterInstance.padding = nextPadding;
      }
    }

    newFilters.push(filterInstance);
  }

  mutableTarget.filters = newFilters;
};
