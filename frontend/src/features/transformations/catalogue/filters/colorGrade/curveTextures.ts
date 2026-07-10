import { BufferImageSource, Texture } from "pixi.js";
import {
  COLOR_CURVE_LUT_HEIGHT,
  COLOR_CURVE_LUT_WIDTH,
  DEFAULT_COLOR_CURVES,
  MODIFIER_CURVE_PARAMETER_NAMES,
  VALUE_CURVE_PARAMETER_NAMES,
  bakeColorCurveLut,
  isIdentityColorCurve,
  type ColorCurveParameterName,
  type ColorCurvePoint,
} from "../../../../../core/color";

export const CURVE_TEXTURE_WIDTH = COLOR_CURVE_LUT_WIDTH;
export const CURVE_TEXTURE_HEIGHT = COLOR_CURVE_LUT_HEIGHT;

function sanitizeCurve(
  value: unknown,
  fallback: readonly ColorCurvePoint[],
): ColorCurvePoint[] {
  if (!Array.isArray(value)) return [...fallback];
  const points = value
    .filter(
      (point): point is ColorCurvePoint =>
        typeof point === "object" &&
        point !== null &&
        "x" in point &&
        "y" in point &&
        typeof point.x === "number" &&
        Number.isFinite(point.x) &&
        typeof point.y === "number" &&
        Number.isFinite(point.y),
    )
    .map((point) => ({
      x: Math.max(0, Math.min(1, point.x)),
      y: point.y,
    }))
    .sort((left, right) => left.x - right.x);
  return points.length > 0 ? points : [...fallback];
}

function curveHash(points: readonly ColorCurvePoint[]): string {
  return points.map((point) => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`).join("|");
}

export class CurveTextureBaker {
  public readonly texture: Texture;
  public readonly pixels: Float32Array;
  private readonly source: BufferImageSource;
  private readonly curves = new Map<
    ColorCurveParameterName,
    readonly ColorCurvePoint[]
  >();
  private readonly hashes = new Map<ColorCurveParameterName, string>();
  private readonly activeCurves = new Set<ColorCurveParameterName>();
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onBake?: () => void;

  constructor(onBake?: () => void) {
    this.onBake = onBake;
    this.pixels = new Float32Array(
      CURVE_TEXTURE_WIDTH * CURVE_TEXTURE_HEIGHT * 4,
    );
    this.source = new BufferImageSource({
      resource: this.pixels,
      width: CURVE_TEXTURE_WIDTH,
      height: CURVE_TEXTURE_HEIGHT,
      format: "rgba32float",
      // RGBA stores four independent curves; A is data, not opacity.
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
      autoGarbageCollect: true,
      label: "color-grade-curves",
    });
    this.texture = new Texture({ source: this.source });
    for (const name of [
      ...VALUE_CURVE_PARAMETER_NAMES,
      ...MODIFIER_CURVE_PARAMETER_NAMES,
    ]) {
      const points = DEFAULT_COLOR_CURVES[name];
      this.curves.set(name, points);
      this.hashes.set(name, curveHash(points));
    }
    this.bakeNow(false);
  }

  public setCurve(name: ColorCurveParameterName, value: unknown): boolean {
    const points = sanitizeCurve(value, DEFAULT_COLOR_CURVES[name]);
    const nextHash = curveHash(points);
    if (this.hashes.get(name) === nextHash) return false;
    this.hashes.set(name, nextHash);
    this.curves.set(name, points);
    if (isIdentityColorCurve(name, points)) {
      this.activeCurves.delete(name);
    } else {
      this.activeCurves.add(name);
    }
    this.scheduleBake();
    return true;
  }

  public get hasActiveCurves(): boolean {
    return this.activeCurves.size > 0;
  }

  public flush(): void {
    if (this.bakeTimer !== null) {
      clearTimeout(this.bakeTimer);
      this.bakeTimer = null;
    }
    this.bakeNow();
  }

  public destroy(): void {
    if (this.bakeTimer !== null) clearTimeout(this.bakeTimer);
    this.bakeTimer = null;
    this.texture.destroy(true);
  }

  private scheduleBake(): void {
    if (this.bakeTimer !== null) return;
    this.bakeTimer = setTimeout(() => {
      this.bakeTimer = null;
      this.bakeNow();
    }, 16);
  }

  private bakeNow(notify = true): void {
    this.pixels.set(
      bakeColorCurveLut(Object.fromEntries(this.curves) as Record<
        ColorCurveParameterName,
        readonly ColorCurvePoint[]
      >),
    );
    this.source.update();
    if (notify) this.onBake?.();
  }
}
