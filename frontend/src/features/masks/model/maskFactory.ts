import { Graphics } from "pixi.js";
import type {
  ClipMask,
  ClipMaskMode,
  ClipMaskParameters,
  ClipMaskPoint,
  ClipMaskType,
  ClipTransform,
} from "../../../types/TimelineTypes";

export const MASK_TYPES: ClipMaskType[] = [
  "circle",
  "rectangle",
  "triangle",
  "sam2",
];
export const MASK_MODES: ClipMaskMode[] = ["apply", "preview", "off"];

export const DEFAULT_MASK_BASE_SIZE = 120;
const CIRCLE_SEGMENTS = 32;

export interface MaskPoint {
  x: number;
  y: number;
}

export interface MaskDrawOptions {
  fillColor?: number;
  includeTransform?: boolean;
}

export interface MaskLayoutState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

interface LegacyMaskParameterInput extends Partial<
  Record<keyof ClipMaskParameters, unknown>
> {
  x?: unknown;
  y?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
  rotation?: unknown;
}

interface MaskCreateOverrides extends Partial<Omit<ClipMask, "parameters">> {
  parameters?: LegacyMaskParameterInput;
}

const DEFAULT_MASK_PARAMETERS: ClipMaskParameters = {
  baseWidth: DEFAULT_MASK_BASE_SIZE,
  baseHeight: DEFAULT_MASK_BASE_SIZE,
};

const DEFAULT_MASK_LAYOUT_STATE: MaskLayoutState = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
};

const LEGACY_MASK_POSITION_ID_SUFFIX = "position";
const LEGACY_MASK_SCALE_ID_SUFFIX = "scale";
const LEGACY_MASK_ROTATION_ID_SUFFIX = "rotation";

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeMaskType(type: string | undefined): ClipMaskType {
  if (
    type === "circle" ||
    type === "triangle" ||
    type === "sam2" ||
    type === "generation"
  ) {
    return type;
  }
  return "rectangle";
}

export function normalizeMaskMode(
  mode: string | undefined,
  isEnabled: boolean | undefined,
): ClipMaskMode {
  if (mode === "apply" || mode === "preview" || mode === "off") {
    return mode;
  }
  if (isEnabled === false) return "off";
  return "apply";
}

function resolveEnabledFromMode(mode: ClipMaskMode): boolean {
  return mode !== "off";
}

function normalizeMaskParameters(
  parameters: LegacyMaskParameterInput | undefined,
): ClipMaskParameters {
  return {
    baseWidth: Math.max(
      1,
      toFiniteNumber(parameters?.baseWidth, DEFAULT_MASK_PARAMETERS.baseWidth),
    ),
    baseHeight: Math.max(
      1,
      toFiniteNumber(
        parameters?.baseHeight,
        DEFAULT_MASK_PARAMETERS.baseHeight,
      ),
    ),
  };
}

function normalizeMaskPointCoordinate(
  value: unknown,
  fallback: number,
): number {
  const numeric = toFiniteNumber(value, fallback);
  return Math.min(1, Math.max(0, numeric));
}

function normalizeMaskPoints(points: unknown): ClipMaskPoint[] | undefined {
  if (!Array.isArray(points)) return undefined;
  return points
    .map((candidate) => {
      if (!isRecord(candidate)) return null;
      const labelRaw = candidate.label;
      const label: 0 | 1 = labelRaw === 0 ? 0 : 1;
      const timeTicksRaw = candidate.timeTicks;
      const timeTicks =
        typeof timeTicksRaw === "number" && Number.isFinite(timeTicksRaw)
          ? timeTicksRaw
          : 0;
      return {
        x: normalizeMaskPointCoordinate(candidate.x, 0.5),
        y: normalizeMaskPointCoordinate(candidate.y, 0.5),
        label,
        timeTicks,
      };
    })
    .filter((point): point is ClipMaskPoint => point !== null);
}

function normalizeMaskLayoutState(
  parameters: LegacyMaskParameterInput | undefined,
): MaskLayoutState {
  return {
    x: toFiniteNumber(parameters?.x, DEFAULT_MASK_LAYOUT_STATE.x),
    y: toFiniteNumber(parameters?.y, DEFAULT_MASK_LAYOUT_STATE.y),
    scaleX: toFiniteNumber(
      parameters?.scaleX,
      DEFAULT_MASK_LAYOUT_STATE.scaleX,
    ),
    scaleY: toFiniteNumber(
      parameters?.scaleY,
      DEFAULT_MASK_LAYOUT_STATE.scaleY,
    ),
    rotation: toFiniteNumber(
      parameters?.rotation,
      DEFAULT_MASK_LAYOUT_STATE.rotation,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createLegacyMaskTransformId(maskId: string, suffix: string): string {
  return `${maskId}:${suffix}`;
}

export function createMaskLayoutTransformsFromParameters(
  maskId: string,
  parameters: ClipMaskParameters,
): ClipTransform[] {
  return createMaskLayoutTransforms(
    maskId,
    normalizeMaskLayoutState(parameters),
  );
}

export function createMaskLayoutTransforms(
  maskId: string,
  layout: MaskLayoutState,
): ClipTransform[] {
  return [
    {
      id: createLegacyMaskTransformId(maskId, LEGACY_MASK_POSITION_ID_SUFFIX),
      type: "position",
      isEnabled: true,
      parameters: {
        x: layout.x,
        y: layout.y,
      },
    },
    {
      id: createLegacyMaskTransformId(maskId, LEGACY_MASK_SCALE_ID_SUFFIX),
      type: "scale",
      isEnabled: true,
      parameters: {
        x: layout.scaleX,
        y: layout.scaleY,
        isLinked: false,
      },
    },
    {
      id: createLegacyMaskTransformId(maskId, LEGACY_MASK_ROTATION_ID_SUFFIX),
      type: "rotation",
      isEnabled: true,
      parameters: {
        angle: layout.rotation,
      },
    },
  ];
}

function toStaticScalar(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (
    isRecord(value) &&
    value.type === "spline" &&
    Array.isArray(value.points) &&
    value.points.length > 0
  ) {
    const firstPoint = value.points[0];
    if (isRecord(firstPoint) && typeof firstPoint.value === "number") {
      return firstPoint.value;
    }
  }

  return fallback;
}

function findLayoutTransform(
  transforms: ClipTransform[],
  type: "position" | "scale" | "rotation",
  legacyId: string,
): ClipTransform | undefined {
  return (
    transforms.find((transform) => transform.id === legacyId) ??
    transforms.find((transform) => transform.type === type)
  );
}

function getTransformIsLinked(transform: ClipTransform | undefined): boolean {
  if (!transform) return false;
  return Boolean(
    isRecord(transform.parameters) &&
    typeof transform.parameters.isLinked === "boolean" &&
    transform.parameters.isLinked,
  );
}

function resolveLayoutFromTransforms(
  mask: Pick<ClipMask, "id" | "transformations">,
): MaskLayoutState {
  const transforms = mask.transformations ?? [];
  const fallback = DEFAULT_MASK_LAYOUT_STATE;

  const positionTransform = findLayoutTransform(
    transforms,
    "position",
    createLegacyMaskTransformId(mask.id, LEGACY_MASK_POSITION_ID_SUFFIX),
  );
  const scaleTransform = findLayoutTransform(
    transforms,
    "scale",
    createLegacyMaskTransformId(mask.id, LEGACY_MASK_SCALE_ID_SUFFIX),
  );
  const rotationTransform = findLayoutTransform(
    transforms,
    "rotation",
    createLegacyMaskTransformId(mask.id, LEGACY_MASK_ROTATION_ID_SUFFIX),
  );

  return {
    x:
      positionTransform && positionTransform.isEnabled !== false
        ? toStaticScalar(positionTransform.parameters.x, fallback.x)
        : fallback.x,
    y:
      positionTransform && positionTransform.isEnabled !== false
        ? toStaticScalar(positionTransform.parameters.y, fallback.y)
        : fallback.y,
    scaleX:
      scaleTransform && scaleTransform.isEnabled !== false
        ? toStaticScalar(scaleTransform.parameters.x, fallback.scaleX)
        : fallback.scaleX,
    scaleY:
      scaleTransform && scaleTransform.isEnabled !== false
        ? toStaticScalar(scaleTransform.parameters.y, fallback.scaleY)
        : fallback.scaleY,
    rotation:
      rotationTransform && rotationTransform.isEnabled !== false
        ? toStaticScalar(rotationTransform.parameters.angle, fallback.rotation)
        : fallback.rotation,
  };
}

function upsertLayoutTransform(
  transforms: ClipTransform[],
  type: "position" | "scale" | "rotation",
  legacyId: string,
  parameters: Record<string, unknown>,
): ClipTransform[] {
  const index = transforms.findIndex(
    (transform) => transform.id === legacyId || transform.type === type,
  );
  if (index === -1) {
    return [
      ...transforms,
      {
        id: legacyId,
        type,
        isEnabled: true,
        parameters,
      },
    ];
  }

  const next = [...transforms];
  const existing = next[index];
  next[index] = {
    ...existing,
    type,
    parameters,
  };
  return next;
}

export function getMaskLayoutState(mask: ClipMask): MaskLayoutState {
  return resolveLayoutFromTransforms(mask);
}

export function setMaskLayoutState(
  mask: ClipMask,
  updates: Partial<MaskLayoutState>,
): ClipTransform[] {
  const currentLayout = getMaskLayoutState(mask);
  const nextLayout = {
    ...currentLayout,
    ...updates,
  };

  let nextTransforms = mask.transformations ?? [];
  const positionId = createLegacyMaskTransformId(
    mask.id,
    LEGACY_MASK_POSITION_ID_SUFFIX,
  );
  nextTransforms = upsertLayoutTransform(
    nextTransforms,
    "position",
    positionId,
    {
      x: nextLayout.x,
      y: nextLayout.y,
    },
  );

  const scaleId = createLegacyMaskTransformId(
    mask.id,
    LEGACY_MASK_SCALE_ID_SUFFIX,
  );
  const currentScaleTransform = findLayoutTransform(
    nextTransforms,
    "scale",
    scaleId,
  );
  nextTransforms = upsertLayoutTransform(nextTransforms, "scale", scaleId, {
    x: nextLayout.scaleX,
    y: nextLayout.scaleY,
    isLinked: getTransformIsLinked(currentScaleTransform),
  });

  const rotationId = createLegacyMaskTransformId(
    mask.id,
    LEGACY_MASK_ROTATION_ID_SUFFIX,
  );
  nextTransforms = upsertLayoutTransform(
    nextTransforms,
    "rotation",
    rotationId,
    {
      angle: nextLayout.rotation,
    },
  );

  return nextTransforms;
}

export function createMask(
  type: ClipMaskType,
  overrides: MaskCreateOverrides = {},
): ClipMask {
  const maskId = overrides.id ?? `mask_${crypto.randomUUID()}`;
  const mode = normalizeMaskMode(overrides.mode, overrides.isEnabled);
  const parameters = normalizeMaskParameters(overrides.parameters);
  const layout = normalizeMaskLayoutState(overrides.parameters);
  const transformations =
    overrides.transformations && overrides.transformations.length > 0
      ? overrides.transformations
      : createMaskLayoutTransforms(maskId, layout);
  const normalizedMaskPoints = normalizeMaskPoints(overrides.maskPoints);

  return {
    id: maskId,
    type,
    mode,
    isEnabled: resolveEnabledFromMode(mode),
    inverted: overrides.inverted ?? true,
    transformations,
    parameters,
    maskPoints: normalizedMaskPoints,
    sam2MaskAssetId: overrides.sam2MaskAssetId,
    sam2GeneratedPointsHash: overrides.sam2GeneratedPointsHash,
    sam2LastGeneratedAt: overrides.sam2LastGeneratedAt,
  };
}

export function getMaskBasePolygon(
  type: ClipMaskType,
  baseWidth: number,
  baseHeight: number,
): MaskPoint[] {
  const halfWidth = baseWidth / 2;
  const halfHeight = baseHeight / 2;

  if (type === "triangle") {
    return [
      { x: 0, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ];
  }

  if (type === "circle") {
    const points: MaskPoint[] = [];
    for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
      const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
      points.push({
        x: Math.cos(angle) * halfWidth,
        y: Math.sin(angle) * halfHeight,
      });
    }
    return points;
  }

  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];
}

export function transformMaskPolygon(
  points: MaskPoint[],
  layout: MaskLayoutState,
): MaskPoint[] {
  const cos = Math.cos(layout.rotation);
  const sin = Math.sin(layout.rotation);

  return points.map((point) => {
    const scaledX = point.x * layout.scaleX;
    const scaledY = point.y * layout.scaleY;

    return {
      x: layout.x + scaledX * cos - scaledY * sin,
      y: layout.y + scaledX * sin + scaledY * cos,
    };
  });
}

function flattenPolygon(points: MaskPoint[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function isPointInsidePolygon(point: MaskPoint, polygon: MaskPoint[]): boolean {
  let inside = false;

  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y || Number.EPSILON) +
          current.x;

    if (intersects) inside = !inside;
  }

  return inside;
}

/**
 * Minimal shape description accepted by drawing/hit-test functions.
 * Both ClipMask and mask TimelineClip satisfy this interface.
 */
export interface MaskShapeSource {
  type?: string;
  maskType?: ClipMaskType;
  parameters?: { baseWidth: number; baseHeight: number };
  maskParameters?: { baseWidth: number; baseHeight: number };
  transformations?: ClipTransform[];
  id?: string;
}

function resolveMaskShapeType(source: MaskShapeSource): ClipMaskType {
  if (source.maskType) return source.maskType;
  return normalizeMaskType(source.type);
}

function resolveMaskShapeParams(source: MaskShapeSource): {
  baseWidth: number;
  baseHeight: number;
} {
  return (
    source.maskParameters ??
    source.parameters ?? { baseWidth: 1, baseHeight: 1 }
  );
}

export function getMaskPolygon(
  mask: MaskShapeSource & { id?: string },
  includeTransform: boolean,
): MaskPoint[] {
  const params = resolveMaskShapeParams(mask);
  const base = getMaskBasePolygon(
    resolveMaskShapeType(mask),
    params.baseWidth,
    params.baseHeight,
  );
  if (!includeTransform) return base;
  const layout = resolveLayoutFromTransforms({
    id: mask.id ?? "",
    transformations: mask.transformations,
  });
  return transformMaskPolygon(base, layout);
}

export function drawMaskShape(
  graphics: Graphics,
  mask: MaskShapeSource,
  options: MaskDrawOptions = {},
) {
  const { fillColor = 0xffffff, includeTransform = true } = options;
  const polygon = getMaskPolygon(mask, includeTransform);
  if (polygon.length < 3) return;
  graphics.poly(flattenPolygon(polygon)).fill(fillColor);
}

export function drawMaskBaseShape(graphics: Graphics, mask: MaskShapeSource) {
  drawMaskShape(graphics, mask, { includeTransform: false });
}

export function isPointInsideMask(
  point: MaskPoint,
  mask: MaskShapeSource & { id?: string },
): boolean {
  const polygon = getMaskPolygon(mask, true);
  return isPointInsidePolygon(point, polygon);
}
