import { Application, Container, RenderTexture, Sprite, Texture } from "pixi.js";
import {
  MASK_DISTANCE_LEVELS_PER_PIXEL,
  MASK_DISTANCE_ZERO_LEVEL,
  resolveDistanceFieldBand,
} from "../../features/masks/model/maskAssetEncoding";
import { MaskAssetDecodeFilter, type MaskAssetDecodeOutput } from "../../features/masks/runtime/MaskAssetDecodeFilter";
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

/** Exact signed distance in pixels at a pixel centre, negative inside. */
type SignedDistance = (centreX: number, centreY: number) => number;

interface ProbeContext {
  shape(
    width: number,
    height: number,
    inside: Inside,
    ops: MaskEdgeOps,
  ): { input: CoverageImage; output: CoverageImage };
  /**
   * Paint `distance` as a distance-band asset frame, decode it through the
   * production decode filter, and shape it from the band.
   */
  shapeField(
    width: number,
    height: number,
    distance: SignedDistance,
    ops: MaskEdgeOps,
  ): { output: CoverageImage; coverage: CoverageImage };
  /**
   * As `shapeField`, but the band frame is drawn as a transformed sprite in a
   * `contentSize` field, and shaped with `fieldBand` (0 forces the flood).
   */
  shapeFieldSprite(options: {
    frameSize: number;
    contentSize: number;
    distance: SignedDistance;
    scale: { x: number; y: number };
    ops: MaskEdgeOps;
    fieldBand: number;
  }): CoverageImage;
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

function paintDistanceBand(
  width: number,
  height: number,
  distance: SignedDistance,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for mask probe");
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = Math.round(
        Math.min(
          255,
          Math.max(
            0,
            MASK_DISTANCE_ZERO_LEVEL -
              MASK_DISTANCE_LEVELS_PER_PIXEL * distance(x + 0.5, y + 0.5),
          ),
        ),
      );
      const index = (y * width + x) * 4;
      // Opaque grey, like a decoded distance-band video frame.
      image.data[index] = level;
      image.data[index + 1] = level;
      image.data[index + 2] = level;
      image.data[index + 3] = 255;
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
      shapeFieldSprite({ frameSize, contentSize, distance, scale, ops, fieldBand }) {
        const canvasTexture = Texture.from(paintDistanceBand(frameSize, frameSize, distance));
        const decodeFilter = new MaskAssetDecodeFilter();
        decodeFilter.setEncoding("tsdf8_k8");
        decodeFilter.setOutput("distance_field");
        decodeFilter.setDistanceScale(Math.min(scale.x, scale.y));
        const root = new Container();
        root.filters = [decodeFilter];
        const sprite = new Sprite(canvasTexture);
        sprite.anchor.set(0.5);
        sprite.position.set(contentSize / 2, contentSize / 2);
        sprite.scale.set(scale.x, scale.y);
        root.addChild(sprite);
        const field = RenderTexture.create({ width: contentSize, height: contentSize, resolution: 1 });
        const target = RenderTexture.create({ width: contentSize, height: contentSize, resolution: 1 });
        try {
          application.renderer.render({ container: root, target: field, clear: true });
          fieldRenderer.renderFromField(field, target, resolveMaskEdgeShape(ops), fieldBand);
          return readRed(application, target);
        } finally {
          root.destroy({ children: true });
          decodeFilter.destroy();
          canvasTexture.destroy(true);
          field.destroy(true);
          target.destroy(true);
        }
      },
      shapeField(width, height, distance, ops) {
        const canvasTexture = Texture.from(paintDistanceBand(width, height, distance));
        const decodeFilter = new MaskAssetDecodeFilter();
        decodeFilter.setEncoding("tsdf8_k8");
        decodeFilter.setDistanceScale(1);
        // As in the mask scene: the decode filter sits on the node's root.
        const root = new Container();
        root.filters = [decodeFilter];
        root.addChild(new Sprite(canvasTexture));
        const decode = (output: MaskAssetDecodeOutput) => {
          decodeFilter.setOutput(output);
          const texture = RenderTexture.create({ width, height, resolution: 1 });
          application.renderer.render({ container: root, target: texture, clear: true });
          return texture;
        };
        const field = decode("distance_field");
        const coverage = decode("coverage");
        const target = RenderTexture.create({ width, height, resolution: 1 });
        try {
          fieldRenderer.renderFromField(
            field,
            target,
            resolveMaskEdgeShape(ops),
            resolveDistanceFieldBand(1),
          );
          return {
            output: readRed(application, target),
            coverage: readRed(application, coverage),
          };
        } finally {
          root.destroy({ children: true });
          decodeFilter.destroy();
          canvasTexture.destroy(true);
          field.destroy(true);
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
  /**
   * A sub-pixel disc stored as a distance band, shaped from the band:
   * deviation from the exact result, per case.
   */
  distanceBand: { label: string; rmsError: number; maxError: number }[];
  /**
   * A solid band frame drawn as a 32x32 sprite and grown 4 px: covered area,
   * flooded from the band's edge vs read from the band directly (which
   * cannot see the sprite border), against the exact rounded square.
   */
  spriteBorder: { floodedArea: number; directArea: number; exactArea: number };
  /**
   * A band disc (radius 20) scaled (2, 0.5) and grown 4 px by flooding from
   * its edge: how far coverage extends past the scaled disc on each axis.
   */
  nonUniformScale: { growAlongX: number; growAlongY: number };
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

    const distanceBand = (() => {
      const size = 160;
      // Vertically centred so readback orientation cannot matter; the
      // horizontal centre and radius are sub-pixel.
      const centreX = 79.37;
      const centreY = size / 2;
      const radius = 40.3;
      const discDistance: SignedDistance = (x, y) =>
        Math.hypot(x - centreX, y - centreY) - radius;
      const compare = (label: string, image: CoverageImage, expected: (d: number) => number) => {
        let squared = 0;
        let maxError = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const error = Math.abs(
              image.values[y * size + x] - expected(discDistance(x + 0.5, y + 0.5)),
            );
            squared += error * error;
            maxError = Math.max(maxError, error);
          }
        }
        return { label, rmsError: Math.sqrt(squared / (size * size)), maxError };
      };

      const results = [];
      const cases: [string, MaskEdgeOps][] = [
        ["grow 5 (one pass)", grow(5)],
        ["shrink 10 (one pass)", grow(-10)],
        ["hard_outer feather 12 (one pass)", feather("hard_outer", 12)],
        ["grow 30 (flood from the band)", grow(30)],
      ];
      for (const [label, ops] of cases) {
        const { output, coverage } = context.shapeField(size, size, discDistance, ops);
        results.push(compare(label, output, (d) => expectedCoverage(ops, d)));
        if (results.length === 1) {
          // The decode filter's own anti-aliased coverage: a one-texel edge.
          results.push(
            compare("decoded coverage", coverage, (d) => expectedCoverage(grow(0), d)),
          );
        }
      }
      return results;
    })();

    const spriteBorder = (() => {
      const solid: SignedDistance = () => -100;
      const shapeSolid = (fieldBand: number) =>
        sum(
          Array.from(
            context.shapeFieldSprite({
              frameSize: 64,
              contentSize: 96,
              distance: solid,
              scale: { x: 0.5, y: 0.5 },
              ops: grow(4),
              fieldBand,
            }).values,
          ),
        );
      return {
        floodedArea: shapeSolid(0),
        directArea: shapeSolid(resolveDistanceFieldBand(0.5)),
        // A 32 px square grown 4 px: 40 x 40 with rounded corners.
        exactArea: 40 * 40 - (4 - Math.PI) * 4 * 4,
      };
    })();

    const nonUniformScale = (() => {
      const frameSize = 64;
      const radius = 20;
      const disc: SignedDistance = (x, y) =>
        Math.hypot(x - frameSize / 2, y - frameSize / 2) - radius;
      const contentSize = 128;
      const image = context.shapeFieldSprite({
        frameSize,
        contentSize,
        distance: disc,
        scale: { x: 2, y: 0.5 },
        ops: grow(4),
        fieldBand: 0,
      });
      const middle = contentSize / 2;
      const rowCovered = sum(row(image, middle));
      let columnCovered = 0;
      for (let y = 0; y < contentSize; y++) {
        columnCovered += image.values[y * contentSize + middle];
      }
      return {
        // Covered width past the scaled disc's own width, split per side.
        growAlongX: (rowCovered - 2 * radius * 2) / 2,
        growAlongY: (columnCovered - 2 * radius * 0.5) / 2,
      };
    })();

    return {
      straightEdge,
      thinLines,
      gap,
      featherRamps,
      diagonal,
      largeReach,
      wideTexture,
      uniform,
      distanceBand,
      spriteBorder,
      nonUniformScale,
    };
  });
}
