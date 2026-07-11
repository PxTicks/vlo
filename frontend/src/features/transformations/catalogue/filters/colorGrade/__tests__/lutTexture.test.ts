import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdentityCubeLut,
  sampleCubeLut,
  serializeCubeLut,
} from "../../../../../../core/color";
import {
  getCubeLutForAsset,
  getLoadedCubeLut,
  planCubeLutAtlas,
  preloadColorGradeLuts,
  setCubeLutTextSourceForTests,
  subscribeCubeLutLoads,
  writeCubeLutAtlas,
} from "../lutTexture";
import { normalizeColorGradeLayer } from "../fusedColorGradeParameters";
import {
  FUSED_GRADE_PARAMETER_TEXTURE_WIDTH,
  FusedColorGradeTextures,
} from "../fusedColorGradeTextures";
import { buildFusedColorGradeFragment } from "../fusedShader";
import { FUSED_COLOR_GRADE_SHADER_STAGE } from "../fusedShaderStages";

const IDENTITY_3 = createIdentityCubeLut(3);

describe("cube LUT atlas", () => {
  it("tiles slices into a near-square grid and stacks grades vertically", () => {
    const plan = planCubeLutAtlas([IDENTITY_3, null, createIdentityCubeLut(2)]);
    // Size 3 → 2×2 slice grid (6×6 texels); size 2 → 2×1 grid (4×2 texels).
    expect(plan.tiles[0]).toMatchObject({ size: 3, tilesX: 2, rowOffset: 0 });
    expect(plan.tiles[1]).toBeNull();
    expect(plan.tiles[2]).toMatchObject({ size: 2, tilesX: 2, rowOffset: 6 });
    expect(plan.width).toBe(6);
    expect(plan.height).toBe(8);
  });

  it("writes lattice texels where the shader's tile addressing reads them", () => {
    const plan = planCubeLutAtlas([IDENTITY_3]);
    const pixels = writeCubeLutAtlas(plan);
    const tile = plan.tiles[0]!;
    // Mirrors vloLutLattice: slice b picks a tile, (r, g) index within it.
    const readLattice = (r: number, g: number, b: number): number[] => {
      const x = (b % tile.tilesX) * tile.size + r;
      const y = tile.rowOffset + Math.floor(b / tile.tilesX) * tile.size + g;
      const offset = (y * plan.width + x) * 4;
      return [...pixels.slice(offset, offset + 3)];
    };
    expect(readLattice(1, 2, 2)).toEqual([0.5, 1, 1]);
    expect(readLattice(0, 0, 0)).toEqual([0, 0, 0]);
    expect(readLattice(2, 0, 1)).toEqual([1, 0, 0.5]);
  });
});

describe("cube LUT asset cache", () => {
  afterEach(() => {
    setCubeLutTextSourceForTests(null);
  });

  it("loads and expands cube text once per asset and notifies on completion", async () => {
    const source = vi.fn(async (assetId: string) =>
      assetId === "lut-1" ? serializeCubeLut(IDENTITY_3) : null,
    );
    setCubeLutTextSourceForTests(source);
    const onLoad = vi.fn();
    const unsubscribe = subscribeCubeLutLoads(onLoad);

    expect(getLoadedCubeLut("lut-1")).toBeNull();
    const loaded = await getCubeLutForAsset("lut-1");
    expect(loaded?.size).toBe(3);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(getLoadedCubeLut("lut-1")).toBe(loaded);
    expect(source).toHaveBeenCalledTimes(1);

    // Failed loads cache the error state silently instead of retrying.
    expect(await getCubeLutForAsset("missing")).toBeNull();
    expect(getLoadedCubeLut("missing")).toBeNull();
    expect(onLoad).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("preloads every LUT referenced by enabled clip grades before export", async () => {
    const source = vi.fn(async () => serializeCubeLut(IDENTITY_3));
    setCubeLutTextSourceForTests(source);

    await preloadColorGradeLuts([
      {
        transformations: [
          {
            type: "filter",
            filterName: "ColorGradeFilter",
            parameters: { lutAssetId: "lut-a" },
          },
          {
            type: "filter",
            filterName: "ColorGradeFilter",
            isEnabled: false,
            parameters: { lutAssetId: "lut-disabled" },
          },
          {
            type: "filter",
            filterName: "BlurFilter",
            parameters: { lutAssetId: "not-a-grade" },
          },
        ],
      },
      { transformations: [] },
      {
        transformations: [
          {
            type: "filter",
            filterName: "ColorGradeFilter",
            parameters: { lutAssetId: "lut-a" },
          },
        ],
      },
    ]);

    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith("lut-a");
    expect(getLoadedCubeLut("lut-a")?.size).toBe(3);
  });
});

describe("fused grade LUT stage", () => {
  afterEach(() => {
    setCubeLutTextSourceForTests(null);
  });

  it("compiles the LUT stage when a grade references a LUT asset", () => {
    const normalized = normalizeColorGradeLayer({
      transformId: "with-lut",
      parameters: { lutAssetId: "lut-1", lutIntensity: 0.5 },
    });
    expect(normalized.variantKey & FUSED_COLOR_GRADE_SHADER_STAGE.LUT).toBe(
      FUSED_COLOR_GRADE_SHADER_STAGE.LUT,
    );
    expect(normalized.parameters.lutIntensity).toBe(0.5);

    const fragment = buildFusedColorGradeFragment([normalized.variantKey]);
    expect(fragment).toContain("uniform sampler2D uLutAtlas;");
    expect(fragment).toContain("vloSampleLut3d");
    expect(fragment).toContain("grade0lut");

    const withoutLut = buildFusedColorGradeFragment([0]);
    expect(withoutLut).not.toContain("uLutAtlas");
  });

  it("keeps the matte preview free of the creative LUT", () => {
    const normalized = normalizeColorGradeLayer({
      transformId: "matte",
      parameters: {
        lutAssetId: "lut-1",
        qualifierEnabled: true,
        mattePreview: true,
      },
    });
    const fragment = buildFusedColorGradeFragment([normalized.variantKey]);
    expect(fragment).not.toContain("vloSampleLut3d");
  });

  it("disables the stage until the asset loads, then bakes atlas and layout", async () => {
    setCubeLutTextSourceForTests(async () => serializeCubeLut(IDENTITY_3));
    const onBake = vi.fn();
    const textures = new FusedColorGradeTextures(onBake);
    const grade = normalizeColorGradeLayer({
      transformId: "with-lut",
      parameters: { lutAssetId: "lut-1", lutIntensity: 0.75 },
    });

    textures.update([grade]);
    const pixelsBefore = textures.parameterSource.resource as Float32Array;
    const lutTexelOffset = 14 * 4;
    // Not loaded yet: the shader sees zero intensity and passes through.
    expect(pixelsBefore[lutTexelOffset]).toBe(0);

    await getCubeLutForAsset("lut-1");
    expect(onBake).toHaveBeenCalled();
    const pixels = textures.parameterSource.resource as Float32Array;
    expect([...pixels.slice(lutTexelOffset, lutTexelOffset + 4)]).toEqual([
      0.75, 3, 2, 0,
    ]);
    // Domain min + inverse scale for the default [0,1] domain, with the
    // 6×6 atlas texel size in the .w slots.
    expect([...pixels.slice(15 * 4, 15 * 4 + 4)]).toEqual([
      0, 0, 0, Math.fround(1 / 6),
    ]);
    expect([...pixels.slice(16 * 4, 16 * 4 + 4)]).toEqual([
      1, 1, 1, Math.fround(1 / 6),
    ]);
    expect(pixels).toHaveLength(FUSED_GRADE_PARAMETER_TEXTURE_WIDTH * 4);

    expect(textures.lutSource.width).toBe(6);
    expect(textures.lutSource.height).toBe(6);
    const atlas = textures.lutSource.resource as Float32Array;
    const probe = sampleCubeLut(IDENTITY_3, [0.5, 1, 1]);
    // Lattice (1, 2, 2) sits at x=1, y=5 in the 2×2 tile grid.
    expect([...atlas.slice((5 * 6 + 1) * 4, (5 * 6 + 1) * 4 + 3)]).toEqual([
      ...probe,
    ]);
    textures.destroy();
  });
});
