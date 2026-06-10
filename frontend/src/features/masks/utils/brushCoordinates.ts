import type { MaskLayoutState } from "../model/maskFactory";

interface Point {
  x: number;
  y: number;
}

const MIN_SCALE = 0.000001;

function safeScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  if (Math.abs(value) < MIN_SCALE) {
    return value < 0 ? -MIN_SCALE : MIN_SCALE;
  }
  return value;
}

export function clipLocalPointToBrushCanvasPoint(
  point: Point,
  canvasSize: { width: number; height: number },
  layout: MaskLayoutState,
): Point {
  const dx = point.x - layout.x;
  const dy = point.y - layout.y;
  const cos = Math.cos(layout.rotation);
  const sin = Math.sin(layout.rotation);
  const unrotatedX = dx * cos + dy * sin;
  const unrotatedY = -dx * sin + dy * cos;

  return {
    x: unrotatedX / safeScale(layout.scaleX) + canvasSize.width / 2,
    y: unrotatedY / safeScale(layout.scaleY) + canvasSize.height / 2,
  };
}
