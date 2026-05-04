import type {
  BrushPaintedBounds,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { MaskLayoutState, MaskShapeSource } from "./maskFactory";
import { createMaskLayoutTransforms } from "./maskFactory";

export type MaskRenderableHitArea =
  | "base-shape"
  | "painted-bounds"
  | "asset-rectangle"
  | "none";

export interface ResolvedMaskRenderableLayout {
  maskClipId: string;
  localMaskId: string;
  contentSize: { width: number; height: number };
  layout: MaskLayoutState;
  hitArea: MaskRenderableHitArea;
  paintedBounds: BrushPaintedBounds | null;
}

type MaskRenderableShapeSource = MaskShapeSource & {
  maskMode?: MaskTimelineClip["maskMode"];
};

const DEFAULT_LAYOUT_STATE: MaskLayoutState = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
};

function isPositiveSize(size: { width: number; height: number } | null): boolean {
  return !!size && size.width > 0 && size.height > 0;
}

function hasRenderablePaintedBounds(
  bounds: BrushPaintedBounds | null,
): bounds is BrushPaintedBounds {
  return !!bounds && bounds.width > 0 && bounds.height > 0;
}

export function getMaskClipLocalId(maskClipId: string): string {
  const parts = maskClipId.split("::mask::");
  return parts[1] ?? maskClipId;
}

export function createMaskRenderableShapeSource(
  maskClip: MaskTimelineClip,
  resolvedLayout: ResolvedMaskRenderableLayout,
): MaskRenderableShapeSource | null {
  const baseLayout = resolvedLayout.layout ?? DEFAULT_LAYOUT_STATE;

  if (resolvedLayout.hitArea === "none") {
    return null;
  }

  if (resolvedLayout.hitArea === "base-shape") {
    return {
      id: maskClip.id,
      maskType: maskClip.maskType,
      maskMode: maskClip.maskMode,
      maskParameters: maskClip.maskParameters,
      transformations: createMaskLayoutTransforms(maskClip.id, baseLayout),
    };
  }

  if (resolvedLayout.hitArea === "asset-rectangle") {
    return {
      id: maskClip.id,
      maskType: "rectangle",
      maskMode: maskClip.maskMode,
      maskParameters: {
        baseWidth: resolvedLayout.contentSize.width,
        baseHeight: resolvedLayout.contentSize.height,
      },
      transformations: createMaskLayoutTransforms(maskClip.id, baseLayout),
    };
  }

  if (!hasRenderablePaintedBounds(resolvedLayout.paintedBounds)) {
    return null;
  }

  const adjustedLayout = resolvePaintedBoundsLayout(
    baseLayout,
    resolvedLayout.contentSize,
    resolvedLayout.paintedBounds,
  );

  return {
    id: maskClip.id,
    maskType: "rectangle",
    maskMode: maskClip.maskMode,
    maskParameters: {
      baseWidth: resolvedLayout.paintedBounds.width,
      baseHeight: resolvedLayout.paintedBounds.height,
    },
    transformations: createMaskLayoutTransforms(maskClip.id, adjustedLayout),
  };
}

export function getMaskRenderableBaseSize(
  renderableShape: MaskShapeSource | null,
): { width: number; height: number } {
  const params =
    renderableShape?.maskParameters ??
    renderableShape?.parameters ?? { baseWidth: 1, baseHeight: 1 };
  return {
    width: Math.max(1, params.baseWidth),
    height: Math.max(1, params.baseHeight),
  };
}

export function resolveMaskRenderableContentSize(
  baseSize: { width: number; height: number },
  fallbackSize: { width: number; height: number },
  assetTextureSize?: { width: number; height: number } | null,
): { width: number; height: number } {
  if (isPositiveSize(assetTextureSize ?? null)) {
    return {
      width: assetTextureSize!.width,
      height: assetTextureSize!.height,
    };
  }

  if (isPositiveSize(fallbackSize)) {
    return fallbackSize;
  }

  return baseSize;
}

export function resolvePaintedBoundsLayout(
  layout: MaskLayoutState,
  canvasSize: { width: number; height: number },
  bounds: BrushPaintedBounds,
): MaskLayoutState {
  const boundsCenterX = bounds.x + bounds.width / 2 - canvasSize.width / 2;
  const boundsCenterY = bounds.y + bounds.height / 2 - canvasSize.height / 2;
  const scaledCenterX = boundsCenterX * layout.scaleX;
  const scaledCenterY = boundsCenterY * layout.scaleY;
  const cos = Math.cos(layout.rotation);
  const sin = Math.sin(layout.rotation);

  return {
    ...layout,
    x: layout.x + scaledCenterX * cos - scaledCenterY * sin,
    y: layout.y + scaledCenterX * sin + scaledCenterY * cos,
  };
}
