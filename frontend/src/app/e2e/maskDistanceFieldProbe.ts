import { Application, RenderTexture, Sprite, Texture } from "pixi.js";
import { MaskDistanceFieldRenderer } from "../../features/masks/runtime/distanceField/MaskDistanceFieldRenderer";
import {
  resolveMaskEdgeShape,
  type MaskEdgeOps,
  type MaskFeatherMode,
} from "../../features/masks/utils/maskEdgeProfile";

/**
 * Real-WebGL probe for distance-field mask edges
 * (docs/mask-distance-field-plan.md). Binary coverage is painted per pixel
 * (centre inside the shape), shaped by the production renderer, and read
 * back, so the spec can compare grow distances, thin features, gap closing
 * and feather ramps against exact geometry.
 */

type Inside = (centreX: number, centreY: number) => boolean;

interface CoverageImage {
  width: number;
  height: number;
  /** Row-major red channel in [0, 1], in readback orientation. */
  values: Float32Array;
}

interface ProbeContext {
  shape(
    width: number,
    height: number,
    inside: Inside,
    ops: MaskEdgeOps,
  ): { input: CoverageImage; output: CoverageImage };
}

function smoothstep01(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** The shaping pass's coverage for an exact signed distance. */
function expectedCoverage(ops: MaskEdgeOps, signedDistance: number): number {
  const shape = resolveMaskEdgeShape(ops);
  const edge = shape.sign * (signedDistance - shape.offset);
  const coverage =
    1 - smoothstep01((edge - shape.rampStart) / (shape.rampEnd - shape.rampStart));
  return shape.invertOutput ? 1 - coverage : coverage;
}

function grow(growPx: number): MaskEdgeOps {
  return { growPx, growInvert: false, feather: null };
}

function feather(mode: MaskFeatherMode, amountPx: number): MaskEdgeOps {
  return { growPx: 0, growInvert: false, feather: { amountPx, mode, invert: false } };
}

function paintCoverage(width: number, height: number, inside: Inside): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for mask probe");
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = inside(x + 0.5, y + 0.5) ? 255 : 0;
      const index = (y * width + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = value;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function readRed(application: Application, texture: RenderTexture): CoverageImage {
  const { pixels, width, height } = application.renderer.extract.pixels(texture);
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index++) {
    values[index] = pixels[index * 4] / 255;
  }
  return { width, height, values };
}

function row(image: CoverageImage, y: number): number[] {
  return Array.from(image.values.subarray(y * image.width, (y + 1) * image.width));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Number of separate runs of covered (>= 0.5) pixels in a row. */
function coveredRuns(values: readonly number[]): number {
  let runs = 0;
  let previous = false;
  for (const value of values) {
    const covered = value >= 0.5;
    if (covered && !previous) runs += 1;
    previous = covered;
  }
  return runs;
}

async function runProbe<T>(probe: (context: ProbeContext) => T): Promise<T> {
  const application = new Application();
  await application.init({
    width: 16,
    height: 16,
    preference: "webgl",
    antialias: false,
    resolution: 1,
    backgroundAlpha: 0,
  });
  const fieldRenderer = new MaskDistanceFieldRenderer(application.renderer);
  try {
    return probe({
      shape(width, height, inside, ops) {
        const canvasTexture = Texture.from(paintCoverage(width, height, inside));
        canvasTexture.source.scaleMode = "nearest";
        const coverage = RenderTexture.create({ width, height, resolution: 1 });
        const target = RenderTexture.create({ width, height, resolution: 1 });
        const sprite = new Sprite(canvasTexture);
        try {
          application.renderer.render({ container: sprite, target: coverage, clear: true });
          fieldRenderer.render(coverage, target, resolveMaskEdgeShape(ops));
          return {
            input: readRed(application, coverage),
            output: readRed(application, target),
          };
        } finally {
          sprite.destroy();
          canvasTexture.destroy(true);
          coverage.destroy(true);
          target.destroy(true);
        }
      },
    });
  } finally {
    fieldRenderer.dispose();
    application.destroy(true, { children: true });
  }
}

export interface MaskDistanceFieldProbeResult {
  /** Authored grow vs covered pixels past a straight edge. */
  straightEdge: { growPx: number; measuredPx: number }[];
  /** A grown line: covered width per row, and whether it stayed one run. */
  thinLines: { lineWidth: number; growPx: number; coveredPx: number; runs: number }[];
  /** Minimum coverage across a 20 px gap after growing both sides. */
  gap: { growPx: number; minGapCoverage: number }[];
  /** Largest per-pixel deviation from the exact ramp along a straight edge. */
  featherRamps: { mode: MaskFeatherMode; amountPx: number; maxError: number; monotonic: boolean }[];
  /** 45-degree staircase grown 1 px vs the exact offset line. */
  diagonal: { rmsError: number; maxError: number };
  /** A single pixel grown 200 px: covered area / (pi r^2). */
  largeReach: { areaRatio: number };
  /** A 4096-wide strip (coarser seed packing): measured grow. */
  wideTexture: { growPx: number; measuredPx: number };
  /** Coverage range after shaping empty and full masks. */
  uniform: { emptyMax: number; fullMin: number };
}

export async function runMaskDistanceFieldProbe(): Promise<MaskDistanceFieldProbeResult> {
  return runProbe((context) => {
    const edgeX = 64;
    const straightEdge = [0.5, 1, 2.25, 10, 40, -10].map((growPx) => {
      const { output } = context.shape(160, 16, (x) => x < edgeX, grow(growPx));
      return { growPx, measuredPx: sum(row(output, 8)) - edgeX };
    });

    const thinLines = [1, 3].map((lineWidth) => {
      const growPx = 10;
      const { output } = context.shape(
        128,
        16,
        (x) => x >= 60 && x < 60 + lineWidth,
        grow(growPx),
      );
      const values = row(output, 8);
      return { lineWidth, growPx, coveredPx: sum(values), runs: coveredRuns(values) };
    });

    const gap = [9, 11].map((growPx) => {
      const { output } = context.shape(
        140,
        16,
        (x) => x < 60 || x >= 80,
        grow(growPx),
      );
      return { growPx, minGapCoverage: Math.min(...row(output, 8).slice(60, 80)) };
    });

    const featherRamps = (["hard_outer", "soft_inner", "two_way"] as const).map((mode) => {
      const amountPx = 20;
      const ops = feather(mode, amountPx);
      const { output } = context.shape(160, 16, (x) => x < edgeX, ops);
      const values = row(output, 8);
      let maxError = 0;
      let monotonic = true;
      values.forEach((value, x) => {
        const expected = expectedCoverage(ops, x + 0.5 - edgeX);
        maxError = Math.max(maxError, Math.abs(value - expected));
        if (x > 0 && value > values[x - 1] + 1 / 255) monotonic = false;
      });
      return { mode, amountPx, maxError, monotonic };
    });

    const diagonal = (() => {
      const size = 128;
      const ops = grow(1);
      const { input, output } = context.shape(size, size, (x, y) => x + y < size, ops);
      // Readback may be vertically flipped relative to the painted canvas.
      const flipped = input.values[2 * size + 2] < 0.5;
      let squared = 0;
      let maxError = 0;
      let count = 0;
      for (let y = 8; y < size - 8; y++) {
        for (let x = 8; x < size - 8; x++) {
          const centreY = flipped ? size - (y + 0.5) : y + 0.5;
          // Inside centres sum to <= size - 1, outside to >= size: the
          // staircase's own edge is the line halfway between.
          const signedDistance = (x + 0.5 + centreY - (size - 0.5)) / Math.SQRT2;
          const error = Math.abs(output.values[y * size + x] - expectedCoverage(ops, signedDistance));
          squared += error * error;
          maxError = Math.max(maxError, error);
          count += 1;
        }
      }
      return { rmsError: Math.sqrt(squared / count), maxError };
    })();

    const largeReach = (() => {
      const size = 512;
      const radius = 200;
      const { output } = context.shape(
        size,
        size,
        (x, y) => Math.floor(x) === size / 2 && Math.floor(y) === size / 2,
        grow(radius),
      );
      return { areaRatio: sum(Array.from(output.values)) / (Math.PI * radius * radius) };
    })();

    const wideTexture = (() => {
      const growPx = 30;
      const wideEdge = 2000;
      const { output } = context.shape(4096, 4, (x) => x < wideEdge, grow(growPx));
      return { growPx, measuredPx: sum(row(output, 2)) - wideEdge };
    })();

    const uniform = {
      emptyMax: Math.max(...context.shape(32, 32, () => false, grow(10)).output.values),
      fullMin: Math.min(...context.shape(32, 32, () => true, grow(-10)).output.values),
    };

    return {
      straightEdge,
      thinLines,
      gap,
      featherRamps,
      diagonal,
      largeReach,
      wideTexture,
      uniform,
    };
  });
}
