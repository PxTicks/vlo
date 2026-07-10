import { BufferImageSource, Texture } from "pixi.js";
import {
  DEFAULT_COLOR_CURVES,
  PERIODIC_CURVE_PARAMETER_NAMES,
  VALUE_CURVE_PARAMETER_NAMES,
  type ColorCurveParameterName,
  type ColorCurvePoint,
} from "../../../../../core/color";
import { MonotoneCubicSpline } from "../../../utils/MonotoneCubicSpline";
import { PeriodicCubicSpline } from "../../../utils/PeriodicCubicSpline";

export const CURVE_TEXTURE_WIDTH = 1024;
export const CURVE_TEXTURE_HEIGHT = 2;

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
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
      label: "color-grade-curves",
    });
    this.texture = new Texture({ source: this.source });
    for (const name of [
      ...VALUE_CURVE_PARAMETER_NAMES,
      ...PERIODIC_CURVE_PARAMETER_NAMES,
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
    this.scheduleBake();
    return true;
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
    const samplers = VALUE_CURVE_PARAMETER_NAMES.map((name) => {
      const points = this.curves.get(name) ?? DEFAULT_COLOR_CURVES[name];
      return new MonotoneCubicSpline(
        points.map((point) => ({ time: point.x, value: point.y })),
      );
    });
    const periodicSamplers = PERIODIC_CURVE_PARAMETER_NAMES.map((name) => {
      const points = this.curves.get(name) ?? DEFAULT_COLOR_CURVES[name];
      const splinePoints = points.map((point) => ({
        time: point.x,
        value: point.y,
      }));
      return name === "curveLumaSat"
        ? new MonotoneCubicSpline(splinePoints)
        : new PeriodicCubicSpline(splinePoints);
    });

    for (let sample = 0; sample < CURVE_TEXTURE_WIDTH; sample += 1) {
      const x = sample / (CURVE_TEXTURE_WIDTH - 1);
      const valueOffset = sample * 4;
      const periodicOffset = (CURVE_TEXTURE_WIDTH + sample) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        this.pixels[valueOffset + channel] = Math.max(
          0,
          Math.min(1, samplers[channel].at(x)),
        );
        this.pixels[periodicOffset + channel] =
          channel < periodicSamplers.length
            ? Math.max(-0.5, Math.min(0.5, periodicSamplers[channel].at(x)))
            : 0;
      }
    }
    this.source.update();
    if (notify) this.onBake?.();
  }
}
