import { Application, Container, Texture } from "pixi.js";
import type { MaskBooleanExpression, MaskTimelineClip } from "../../types/TimelineTypes";
import { analyzeMaskBooleanExpression } from "../../features/masks/model/maskBooleanExpression";
import { AssetMaskSourceFactory } from "../../features/masks/runtime/AssetMaskSourceFactory";
import { MaskSceneNodeRegistry } from "../../features/masks/runtime/MaskSceneNodeRegistry";
import {
  MaskTextureResolver,
  type ResolvedMaskCompositeState,
} from "../../features/masks/runtime/MaskTextureResolver";
import { MASK_DISTANCE_LEVELS_PER_PIXEL, MASK_DISTANCE_ZERO_LEVEL } from "../../features/masks/model/maskAssetEncoding";

type Distance = (x: number, y: number) => number;
type Operator = "union" | "intersect" | "subtract";

interface ProbeLeaf {
  id: string;
  distance: Distance;
  grow?: number;
  inverted?: boolean;
  binary?: boolean;
  antialiased?: boolean;
  scale?: [number, number];
}

interface ProbeCase {
  leaves: ProbeLeaf[];
  expression: MaskBooleanExpression;
  grow?: number;
  feather?: ResolvedMaskCompositeState["feather"];
  inverse?: boolean;
}

interface ProbeImage {
  values: Float32Array;
  size: number;
}

function reference(id: string, inverted = false): MaskBooleanExpression {
  return { kind: "mask_ref", maskId: id, inverted };
}

function operation(operator: Operator, left = reference("a"), right = reference("b")): MaskBooleanExpression {
  return { kind: "operation", operator, left, right };
}

function maskClip(leaf: ProbeLeaf): MaskTimelineClip {
  return {
    id: leaf.id, trackId: "probe", type: "mask", name: leaf.id,
    sourceDuration: 100, start: 0, timelineDuration: 100, offset: 0,
    transformedDuration: 100, transformedOffset: 0, croppedSourceDuration: 100,
    transformations: [], maskType: leaf.antialiased ? "brush" : "sam2", maskMode: "apply",
    maskInverted: leaf.inverted ?? false, sam2GrowAmount: leaf.grow ?? 0,
    maskParameters: { baseWidth: 128, baseHeight: 128 },
  };
}

function paintLeaf(leaf: ProbeLeaf, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Mask field probe needs a 2D canvas");
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = leaf.distance(x + 0.5, y + 0.5);
      const level = leaf.antialiased
        ? Math.round(255 * Math.min(1, Math.max(0, 0.5 - distance / 2)))
        : leaf.binary
        ? (distance < 0 ? 255 : 0)
        : Math.round(Math.max(0, Math.min(255, MASK_DISTANCE_ZERO_LEVEL - MASK_DISTANCE_LEVELS_PER_PIXEL * distance)));
      const index = (y * size + x) * 4;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = level;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Exact coverage for a one-texel hard edge. */
function coverage(distance: number): number {
  const t = Math.min(1, Math.max(0, distance + 0.5));
  return 1 - t * t * (3 - 2 * t);
}

function compare(image: ProbeImage, expected: Distance): { rmsError: number; maxError: number } {
  let squared = 0;
  let maxError = 0;
  for (let y = 0; y < image.size; y++) {
    for (let x = 0; x < image.size; x++) {
      const error = Math.abs(image.values[y * image.size + x] - expected(x + 0.5, y + 0.5));
      squared += error * error;
      maxError = Math.max(maxError, error);
    }
  }
  return { rmsError: Math.sqrt(squared / image.values.length), maxError };
}

function area(image: ProbeImage): number {
  return image.values.reduce((sum, value) => sum + value, 0);
}

export interface MaskCompositeFieldProbeResult {
  subpixel: { label: string; rmsError: number; maxError: number }[];
  crossings: {
    label: string;
    rmsError: number;
    maxError: number;
    junctionMaxError: number;
    sampleLineJunctionError: number;
    junctionSamples: number;
    edgeSamples: number;
  }[];
  seams: { label: string; minimum: number }[];
  identities: { label: string; maxError: number }[];
  erasedFeatureArea: number;
  binaryFieldMaxError: number;
  singleBrushMaxError: number;
  brushGrowMaxError: number;
  transformed: { label: string; measured: number; expected: number; tolerance: number }[];
}

/** Real resolver, real boolean filter and real WebGL readback, without media IO. */
export async function runMaskCompositeFieldProbe(): Promise<MaskCompositeFieldProbeResult> {
  const application = new Application();
  await application.init({ width: 128, height: 128, preference: "webgl", antialias: false, resolution: 1, autoStart: false });
  const size = 128;
  let flipY = false;
  const render = (testCase: ProbeCase): ProbeImage => {
    const container = new Container();
    const factory = new AssetMaskSourceFactory(application.renderer);
    const registry = new MaskSceneNodeRegistry(container, factory, () => true);
    registry.reconcileAssetMaskNodes(testCase.leaves.map((leaf) => ({ maskId: leaf.id, assetId: leaf.id, kind: "image" })));
    const textures: Texture[] = [];
    for (const leaf of testCase.leaves) {
      const node = registry.getAssetNode(leaf.id);
      if (!node) throw new Error("Mask field probe node missing");
      const texture = Texture.from(paintLeaf(leaf, size));
      textures.push(texture);
      node.player.sprite.texture = texture;
      node.player.sprite.visible = true;
      node.player.sprite.anchor.set(0.5);
      if (leaf.scale) node.player.sprite.scale.set(...leaf.scale);
      node.decodeFilter.setEncoding(leaf.binary || leaf.antialiased ? "binary" : "tsdf8_k8");
    }
    const resolver = new MaskTextureResolver(application.renderer, registry, () => true);
    try {
      const texture = resolver.resolveCoverageTexture({
        expression: testCase.expression,
        expressionAnalysis: analyzeMaskBooleanExpression(testCase.expression),
        maskClipByLocalId: new Map(testCase.leaves.map((leaf) => [leaf.id, maskClip(leaf)])),
        contentSize: { width: size, height: size },
        compositeState: {
          compositeInvert: testCase.inverse ?? false,
          growAmount: testCase.grow ?? 0, growInvert: false,
          feather: testCase.feather ?? null,
        },
      });
      if (!texture) throw new Error("Mask field probe produced no coverage");
      const { pixels } = application.renderer.extract.pixels(texture);
      return {
        size,
        values: Float32Array.from({ length: size * size }, (_, index) => {
          const y = Math.floor(index / size);
          const sourceIndex = flipY ? (size - y - 1) * size + index % size : index;
          return pixels[sourceIndex * 4] / 255;
        }),
      };
    } finally {
      resolver.dispose();
      registry.reconcileAssetMaskNodes([]);
      container.destroy({ children: true });
      textures.forEach((texture) => texture.destroy(true));
    }
  };

  try {
    // Extract may flip render-texture rows. Calibrate before comparing
    // asymmetric horizontal boundaries to geometry in canvas coordinates.
    const orientation = render({
      leaves: [{ id: "a", distance: (_x, y) => y - 10.3 }],
      expression: reference("a"),
    });
    flipY = orientation.values[0] < 0.5;
    const leftEdge: ProbeLeaf = { id: "a", distance: (x) => x - 50.3 };
    const rightEdge: ProbeLeaf = { id: "b", distance: (x) => x - 80.2 };
    const subpixel = (["union", "intersect", "subtract"] as const).flatMap((operator) =>
      [false, true].filter((inverse) => !(operator === "subtract" && inverse)).map((inverse) => {
        const left = operator === "subtract" ? rightEdge : leftEdge;
        const right = operator === "subtract" ? leftEdge : rightEdge;
        const image = render({
          leaves: [{ ...left, id: "a" }, { ...right, id: "b" }],
          expression: operation(operator), inverse,
        });
        const expected: Distance = (x, y) => {
          const sign = inverse ? -1 : 1;
          const a = sign * left.distance(x, y);
          const b = sign * right.distance(x, y);
          const d = operator === "union" ? Math.min(a, b)
            : operator === "intersect" ? Math.max(a, b) : Math.max(a, -b);
          return coverage(sign * d);
        };
        return { label: `${operator}, ${inverse ? "inverse" : "normal"}`, ...compare(image, expected) };
      }),
    );
    subpixel.push({
      label: "leaf grow before inversion",
      ...compare(render({
        leaves: [{ ...leftEdge, grow: 3, inverted: true }, rightEdge],
        expression: operation("intersect"),
      }), (x) => coverage(Math.max(53.3 - x, x - 80.2))),
    });

    // Independent Euclidean distance to two crossing half-planes. Unlike
    // min/max of the inputs, this includes the distance to their joint corner.
    const intersectionDistance = (a: number, b: number) =>
      Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0);
    // Corner error depends on where the corner falls within a texel, so each
    // case reports its worst over a grid of sub-pixel corner positions. A
    // phase of 0 is omitted: edges on texel boundaries have no AA samples.
    const CORNER_PHASES = [0.1, 0.3, 0.5, 0.7, 0.9];
    const crossings = (["union", "intersect", "subtract"] as const).flatMap((operator) =>
      [false, true].map((inverse) => {
        let worst = { rmsError: 0, maxError: 0, junctionMaxError: 0, phase: "none" };
        let sampleLineJunctionError = 0;
        let junctionSamples = Infinity;
        let edgeSamples = Infinity;
        for (const phaseX of CORNER_PHASES) {
          for (const phaseY of CORNER_PHASES) {
            const crossingX = 63 + phaseX;
            const crossingY = 64 + phaseY;
            const image = render({
              leaves: [
                { id: "a", distance: (x) => x - crossingX },
                { id: "b", distance: (_x, y) => y - crossingY },
              ],
              expression: operation(operator), inverse,
            });
            const expected: Distance = (x, y) => {
              const sign = inverse ? -1 : 1;
              const a = sign * (x - crossingX);
              const b = sign * (y - crossingY);
              const d = operator === "union" ? -intersectionDistance(-a, -b)
                : operator === "intersect" ? intersectionDistance(a, b)
                  : intersectionDistance(a, -b);
              return coverage(sign * d);
            };
            let junctionMaxError = 0;
            let junctions = 0;
            let edges = 0;
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++) {
                const value = expected(x + 0.5, y + 0.5);
                if (value > 0 && value < 1) edges += 1;
                if (Math.abs(x + 0.5 - crossingX) <= 1 && Math.abs(y + 0.5 - crossingY) <= 1) {
                  junctions += 1;
                  junctionMaxError = Math.max(junctionMaxError, Math.abs(image.values[y * size + x] - value));
                }
              }
            }
            junctionSamples = Math.min(junctionSamples, junctions);
            edgeSamples = Math.min(edgeSamples, edges);
            const { rmsError, maxError } = compare(image, expected);
            if (phaseX === 0.5 || phaseY === 0.5) {
              // Known limitation (plan §6): an edge through a row of texel
              // centres quantizes to zero there, so the corner texel's only
              // 4-neighbour crossing interpolates across the min/max kink, or
              // there is none. Reported apart so it cannot mask regressions at
              // every other corner position.
              sampleLineJunctionError = Math.max(sampleLineJunctionError, junctionMaxError);
              worst = { ...worst, rmsError: Math.max(worst.rmsError, rmsError) };
              continue;
            }
            worst = {
              rmsError: Math.max(worst.rmsError, rmsError),
              maxError: Math.max(worst.maxError, maxError),
              junctionMaxError: Math.max(worst.junctionMaxError, junctionMaxError),
              phase: maxError > worst.maxError ? `${phaseX}, ${phaseY}` : worst.phase,
            };
          }
        }
        return {
          label: `crossing ${operator}, ${inverse ? "inverse" : "normal"} (worst at ${worst.phase})`,
          rmsError: worst.rmsError, maxError: worst.maxError,
          junctionMaxError: worst.junctionMaxError, sampleLineJunctionError,
          junctionSamples, edgeSamples,
        };
      }),
    );
    subpixel.push({
      label: "union grow beyond stored band",
      ...compare(render({ leaves: [leftEdge, rightEdge], expression: operation("union"), grow: 24 }),
        (x) => coverage(x - 104.2)),
    });

    const abutting: ProbeLeaf[] = [
      { id: "a", distance: (x, y) => Math.max(20.3 - x, x - 64.25, 20.4 - y, y - 108.2) },
      { id: "b", distance: (x, y) => Math.max(64.25 - x, x - 108.7, 20.4 - y, y - 108.2) },
    ];
    const seams = [
      { label: "hard edge", grow: 0 },
      { label: "shrink 8", grow: -8 },
      { label: "inner feather 12", feather: { amount: 12, mode: "soft_inner" as const, invert: false } },
      { label: "grow 4 then inner feather 12", grow: 4, feather: { amount: 12, mode: "soft_inner" as const, invert: false } },
    ].map((options) => {
      const image = render({ leaves: abutting, expression: operation("union"), ...options });
      const strip = image.values.subarray(64 * size + 60, 64 * size + 69);
      return { label: options.label, minimum: Math.min(...strip) };
    });

    const identities = [false, true].flatMap((inverted) => {
      const leaves = [{ ...leftEdge, inverted }, rightEdge];
      const tests: [string, MaskBooleanExpression, Distance][] = [
        ["union complement", operation("union", reference("a"), reference("a", true)), () => 1],
        ["intersection complement", operation("intersect", reference("a"), reference("a", true)), () => 0],
        ["self subtraction", operation("subtract", reference("a"), reference("a")), () => 0],
        ["nested union", operation("intersect", operation("union"), reference("b")), (x) => coverage(x - 80.2)],
      ];
      return tests.map(([label, expression, expected]) => ({
        label: `${label}, leaf inverted ${inverted}`,
        ...compare(render({ leaves, expression }), expected),
      }));
    });
    identities.push({
      label: "inverse subtract containment is full, not an edge case",
      ...compare(render({
        leaves: [{ ...rightEdge, id: "a" }, { ...leftEdge, id: "b" }],
        expression: operation("subtract"), inverse: true,
      }), () => 1),
    });

    const disc: ProbeLeaf = { id: "a", distance: (x, y) => Math.hypot(x - 64, y - 64) - 4, grow: -6 };
    const erasedFeatureArea = area(render({ leaves: [disc], expression: operation("union", reference("a"), reference("a")), grow: 6 }));
    const binary = render({ leaves: [{ ...leftEdge, binary: true }], expression: operation("union", reference("a"), reference("a")), grow: 4 });
    const binaryFieldMaxError = compare(binary, (x) => coverage(x - 54)).maxError;
    const brush: ProbeLeaf = { id: "a", distance: (x) => x - 50.3, antialiased: true };
    const singleBrush = render({ leaves: [brush], expression: reference("a"), grow: 4 });
    const wrappedBrush = render({ leaves: [brush], expression: operation("union", reference("a"), reference("a")), grow: 4 });
    const singleBrushMaxError = Math.max(...singleBrush.values.map((value, index) => Math.abs(value - wrappedBrush.values[index])));
    // Agreement alone would pass if both paths misplaced the edge identically.
    const brushGrowMaxError = compare(singleBrush, (x) => coverage(x - 54.3)).maxError;
    const repeated = operation("union", reference("a"), reference("a"));
    const border = render({
      leaves: [{ id: "a", distance: () => -100, scale: [0.25, 0.25] }],
      expression: repeated, grow: 4,
    });
    const stretched = render({
      leaves: [{ id: "a", distance: (x, y) => Math.hypot(x - 64, y - 64) - 20, scale: [2, 0.5] }],
      expression: repeated, grow: 4,
    });
    let column = 0;
    for (let y = 0; y < size; y++) column += stretched.values[y * size + size / 2];
    const row = stretched.values.subarray(size * size / 2, size * (size / 2 + 1));
    const transformed = [
      { label: "sprite border area", measured: area(border), expected: 40 * 40 - (4 - Math.PI) * 16, tolerance: 8 },
      { label: "nonuniform grow x", measured: (row.reduce((sum, value) => sum + value, 0) - 80) / 2, expected: 4, tolerance: 0.3 },
      { label: "nonuniform grow y", measured: (column - 20) / 2, expected: 4, tolerance: 0.3 },
    ];
    return { subpixel, crossings, seams, identities, erasedFeatureArea, binaryFieldMaxError, singleBrushMaxError, brushGrowMaxError, transformed };
  } finally {
    application.destroy(true, { children: true });
  }
}
