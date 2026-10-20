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
  });
}

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
 *    coverage's 0.5 boundary crosses one of its edges.
 * 2. Flood: a bounded jump flood propagates the nearest seed to every texel
 *    within the shape's reach.
 * 3. Shape: signed distance to that seed, offset by the grow and ramped by
 *    the feather, is written to the target as coverage.
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
   */
  public render(
    coverage: Texture,
    target: RenderTexture,
    shape: MaskEdgeShape,
  ): void {
    const width = coverage.source.pixelWidth;
    const height = coverage.source.pixelHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    const passes = this.ensurePasses();
    const seedTargets = this.ensureSeedTargets(width, height);
    const seedScale = resolveSeedCoordinateScale(Math.max(width, height));

    passes.seedUniforms.uniforms.uSize[0] = width;
    passes.seedUniforms.uniforms.uSize[1] = height;
    passes.seedUniforms.uniforms.uSeedScale = seedScale;
    passes.seed.shader.resources.uCoverage = coverage.source;
    this.renderer.render({
      container: passes.seed.mesh,
      target: seedTargets[0],
      clear: true,
    });

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

    const shapeUniforms = passes.shapeUniforms.uniforms;
    shapeUniforms.uSeedScale = seedScale;
    shapeUniforms.uOffset = shape.offset;
    shapeUniforms.uSign = shape.sign;
    shapeUniforms.uRampStart = shape.rampStart;
    shapeUniforms.uRampEnd = shape.rampEnd;
    shapeUniforms.uInvertOutput = shape.invertOutput ? 1 : 0;
    passes.shape.shader.resources.uSeeds = seedTargets[read].source;
    passes.shape.shader.resources.uCoverage = coverage.source;
    this.renderer.render({ container: passes.shape.mesh, target, clear: true });

    // Drop texture references so a destroyed coverage texture is not kept
    // bound to an idle pass.
    passes.seed.shader.resources.uCoverage = Texture.EMPTY.source;
    passes.shape.shader.resources.uCoverage = Texture.EMPTY.source;
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
        uCoverage: Texture.EMPTY.source,
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
        uCoverage: Texture.EMPTY.source,
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
