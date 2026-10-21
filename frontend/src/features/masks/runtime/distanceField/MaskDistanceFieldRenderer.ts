import {
  GlProgram,
  Mesh,
  MeshGeometry,
  RenderTexture,
  Shader,
  Texture,
  UniformGroup,
  type Renderer,
} from "pixi.js";
import {
  buildJumpFloodSteps,
  resolveSeedCoordinateScale,
  type MaskEdgeShape,
} from "../../utils/maskEdgeProfile";
import { MASK_DISTANCE_BAND_PX } from "../../model/maskAssetEncoding";
import {
  DISTANCE_FIELD_FLOOD_FRAGMENT,
  DISTANCE_FIELD_SEED_FRAGMENT,
  DISTANCE_FIELD_SHAPE_FRAGMENT,
  DISTANCE_FIELD_VERTEX,
} from "./distanceFieldShaders";

function createSeedUniforms() {
  return new UniformGroup({
    uSize: { value: new Float32Array(2), type: "vec2<f32>" },
    uSeedScale: { value: 1, type: "f32" },
    uSourceIsField: { value: 0, type: "f32" },
    uSmoothCoverage: { value: 1, type: "f32" },
  });
}

function createFloodUniforms() {
  return new UniformGroup({
    uSize: { value: new Float32Array(2), type: "vec2<f32>" },
    uSeedScale: { value: 1, type: "f32" },
    uStep: { value: 1, type: "f32" },
  });
}

function createShapeUniforms() {
  return new UniformGroup({
    uSeedScale: { value: 1, type: "f32" },
    uOffset: { value: 0, type: "f32" },
    uSign: { value: 1, type: "f32" },
    uRampStart: { value: -0.5, type: "f32" },
    uRampEnd: { value: 0.5, type: "f32" },
    uInvertOutput: { value: 0, type: "f32" },
    uDistanceSource: { value: 0, type: "f32" },
    uOutputIsField: { value: 0, type: "f32" },
  });
}

/** Where the shape pass reads its signed distance (see the shader). */
const DISTANCE_FROM_SEEDS_SIGNED_BY_COVERAGE = 0;
const DISTANCE_FROM_FIELD = 1;
const DISTANCE_FROM_SEEDS_SIGNED_BY_FIELD = 2;

interface DistancePass {
  mesh: Mesh<MeshGeometry, Shader>;
  shader: Shader;
}

interface DistanceFieldPasses {
  geometry: MeshGeometry;
  seed: DistancePass;
  seedUniforms: ReturnType<typeof createSeedUniforms>;
  flood: DistancePass;
  floodUniforms: ReturnType<typeof createFloodUniforms>;
  shape: DistancePass;
  shapeUniforms: ReturnType<typeof createShapeUniforms>;
}

function createPass(
  geometry: MeshGeometry,
  name: string,
  fragment: string,
  resources: Record<string, unknown>,
): DistancePass {
  const shader = new Shader({
    glProgram: GlProgram.from({
      vertex: DISTANCE_FIELD_VERTEX,
      fragment,
      name,
      preferredFragmentPrecision: "highp",
    }),
    resources,
  });
  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  // Passes overwrite packed data; blending must never touch it.
  mesh.blendMode = "none";
  return { mesh, shader };
}

/**
 * GPU signed-distance-field edge shaping for mask coverage
 * (docs/mask-distance-field-plan.md).
 *
 * 1. Seed: every boundary texel stores the nearest sub-pixel point where the
 *    coverage's 0.5 boundary (or a distance band's zero) crosses one of its
 *    edges.
 * 2. Flood: a bounded jump flood propagates the nearest seed to every texel
 *    within the shape's reach.
 * 3. Shape: signed distance to that seed, offset by the grow and ramped by
 *    the feather, is written to the target as coverage.
 *
 * A source that already is a distance band skips steps 1-2 whenever the
 * shape's ramp stays inside the band.
 *
 * The passes draw meshes straight into owned render textures, not filters:
 * a filter copies its input every application, which would double the pass
 * count, and filter frames do not map texels one-to-one.
 */
export class MaskDistanceFieldRenderer {
  private readonly renderer: Renderer;
  private passes: DistanceFieldPasses | null = null;
  private seedTargets: [RenderTexture, RenderTexture] | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /**
   * Shape `coverage` (red channel) into `target`. The two textures must be
   * the same size in texels, and must not be the same texture.
   * Anti-aliased rasters use their raw 0.5 crossing; binary coverage keeps
   * the pre-blurred seed placement.
   */
  public render(
    coverage: Texture,
    target: RenderTexture,
    shape: MaskEdgeShape,
    sourceKind: "coverage" | "antialiased" = "coverage",
  ): void {
    this.renderPasses(coverage, target, shape, sourceKind);
  }

  /**
   * Shape a distance band (MaskAssetDecodeFilter's `distance_field` output)
   * into `target`. A shape whose ramp reads no farther than `fieldBand`
   * texels is a single pass; a wider one floods from the band's sub-pixel
   * zero crossing.
   */
  public renderFromField(
    field: Texture,
    target: RenderTexture,
    shape: MaskEdgeShape,
    fieldBand: number,
  ): void {
    if (shape.extent <= fieldBand) {
      this.renderShapePass(field, target, shape, DISTANCE_FROM_FIELD, null);
      return;
    }
    this.renderPasses(field, target, shape, "field");
  }

  /**
   * Build a distance band for boolean composition. An offset is applied before
   * inversion, preserving leaf grow → leaf invert. Flooding far enough for
   * both the offset and the output band avoids shifting saturated source data.
   */
  public renderField(
    source: Texture,
    target: RenderTexture,
    options: {
      sourceKind: "coverage" | "antialiased" | "field";
      growTexels: number;
      inverted: boolean;
    },
  ): void {
    const extent = Math.abs(options.growTexels) + MASK_DISTANCE_BAND_PX;
    this.renderPasses(
      source,
      target,
      {
        offset: options.growTexels,
        sign: 1,
        rampStart: -0.5,
        rampEnd: 0.5,
        invertOutput: options.inverted,
        extent,
        reach: extent + 1,
      },
      options.sourceKind,
      true,
    );
  }

  private renderPasses(
    source: Texture,
    target: RenderTexture,
    shape: MaskEdgeShape,
    sourceKind: "coverage" | "antialiased" | "field",
    outputIsField = false,
  ): void {
    const width = source.source.pixelWidth;
    const height = source.source.pixelHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    const passes = this.ensurePasses();
    const seedTargets = this.ensureSeedTargets(width, height);
    const seedScale = resolveSeedCoordinateScale(Math.max(width, height));

    passes.seedUniforms.uniforms.uSize[0] = width;
    passes.seedUniforms.uniforms.uSize[1] = height;
    passes.seedUniforms.uniforms.uSeedScale = seedScale;
    passes.seedUniforms.uniforms.uSourceIsField = sourceKind === "field" ? 1 : 0;
    passes.seedUniforms.uniforms.uSmoothCoverage = sourceKind === "coverage" ? 1 : 0;
    passes.seed.shader.resources.uSource = source.source;
    this.renderer.render({
      container: passes.seed.mesh,
      target: seedTargets[0],
      clear: true,
    });
    // Drop the reference so a destroyed source is not kept bound to an idle pass.
    passes.seed.shader.resources.uSource = Texture.EMPTY.source;

    let read = 0;
    passes.floodUniforms.uniforms.uSize[0] = width;
    passes.floodUniforms.uniforms.uSize[1] = height;
    passes.floodUniforms.uniforms.uSeedScale = seedScale;
    for (const step of buildJumpFloodSteps(shape.reach, Math.max(width, height))) {
      passes.floodUniforms.uniforms.uStep = step;
      passes.flood.shader.resources.uSeeds = seedTargets[read].source;
      this.renderer.render({
        container: passes.flood.mesh,
        target: seedTargets[1 - read],
        clear: true,
      });
      read = 1 - read;
    }

    this.renderShapePass(
      source,
      target,
      shape,
      sourceKind === "field"
        ? DISTANCE_FROM_SEEDS_SIGNED_BY_FIELD
        : DISTANCE_FROM_SEEDS_SIGNED_BY_COVERAGE,
      { texture: seedTargets[read], seedScale },
      outputIsField,
    );
  }

  private renderShapePass(
    source: Texture,
    target: RenderTexture,
    shape: MaskEdgeShape,
    distanceSource: number,
    seeds: { texture: RenderTexture; seedScale: number } | null,
    outputIsField = false,
  ): void {
    const passes = this.ensurePasses();
    const shapeUniforms = passes.shapeUniforms.uniforms;
    shapeUniforms.uSeedScale = seeds?.seedScale ?? 1;
    shapeUniforms.uOffset = shape.offset;
    shapeUniforms.uSign = shape.sign;
    shapeUniforms.uRampStart = shape.rampStart;
    shapeUniforms.uRampEnd = shape.rampEnd;
    shapeUniforms.uInvertOutput = shape.invertOutput ? 1 : 0;
    shapeUniforms.uDistanceSource = distanceSource;
    shapeUniforms.uOutputIsField = outputIsField ? 1 : 0;
    passes.shape.shader.resources.uSeeds = seeds?.texture.source ?? Texture.EMPTY.source;
    passes.shape.shader.resources.uSource = source.source;
    this.renderer.render({ container: passes.shape.mesh, target, clear: true });
    passes.shape.shader.resources.uSource = Texture.EMPTY.source;
  }

  public dispose(): void {
    if (this.passes) {
      for (const pass of [this.passes.seed, this.passes.flood, this.passes.shape]) {
        pass.mesh.destroy();
        // GlProgram.from caches programs by source, so every renderer shares
        // them; destroying them here would break the other masks' renderers.
        pass.shader.destroy();
      }
      this.passes.geometry.destroy();
      this.passes = null;
    }
    this.seedTargets?.forEach((texture) => texture.destroy(true));
    this.seedTargets = null;
  }

  private ensurePasses(): DistanceFieldPasses {
    if (this.passes) {
      return this.passes;
    }

    // A clip-space quad: the vertex shader ignores Pixi's projection, so the
    // quad covers whatever target the pass renders into.
    const geometry = new MeshGeometry({
      positions: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const seedUniforms = createSeedUniforms();
    const floodUniforms = createFloodUniforms();
    const shapeUniforms = createShapeUniforms();
    this.passes = {
      geometry,
      seed: createPass(geometry, "mask-distance-field-seed", DISTANCE_FIELD_SEED_FRAGMENT, {
        uSource: Texture.EMPTY.source,
        seedUniforms,
      }),
      seedUniforms,
      flood: createPass(geometry, "mask-distance-field-flood", DISTANCE_FIELD_FLOOD_FRAGMENT, {
        uSeeds: Texture.EMPTY.source,
        floodUniforms,
      }),
      floodUniforms,
      shape: createPass(geometry, "mask-distance-field-shape", DISTANCE_FIELD_SHAPE_FRAGMENT, {
        uSeeds: Texture.EMPTY.source,
        uSource: Texture.EMPTY.source,
        shapeUniforms,
      }),
      shapeUniforms,
    };
    return this.passes;
  }

  private ensureSeedTargets(
    width: number,
    height: number,
  ): [RenderTexture, RenderTexture] {
    if (!this.seedTargets) {
      const create = (index: number) =>
        RenderTexture.create({
          width,
          height,
          resolution: 1,
          scaleMode: "nearest",
          // Sampled only by these shaders; Pixi's GC would evict it without
          // unbinding it (the 8.15 stale-bind bug).
          autoGarbageCollect: false,
          label: `mask-distance-field-seeds-${index}`,
        });
      this.seedTargets = [create(0), create(1)];
      return this.seedTargets;
    }

    for (const texture of this.seedTargets) {
      if (
        texture.source.pixelWidth !== width ||
        texture.source.pixelHeight !== height
      ) {
        texture.resize(width, height, 1);
      }
    }
    return this.seedTargets;
  }
}
