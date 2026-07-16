import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionFilterRenderSample,
  ExtensionPixiFilterOptions,
  ExtensionPixiRuntime,
  ExtensionTrustedFilterApplyContext,
} from "@vlo/extension-sdk";
import { createMatrixRainFilter } from "../MatrixRainFilter";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "../constants";

interface MockFilter {
  readonly name: string;
  readonly resources: Record<string, unknown>;
  apply?: unknown;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockTexture {
  readonly source: {
    style: object;
    width: number;
    height: number;
    destroyed?: boolean;
  };
  destroy: ReturnType<typeof vi.fn>;
}

interface TextureCreateOptions {
  readonly width: number;
  readonly height: number;
  readonly resolution?: number;
  readonly scaleMode?: string;
  readonly antialias?: boolean;
  readonly autoGenerateMipmaps?: boolean;
  readonly autoGarbageCollect?: boolean;
}

function isUniformGroup(value: unknown): value is Record<string, { value: unknown }> {
  if (typeof value !== "object" || value === null || "style" in value) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every((entry) => typeof entry === "object" && entry !== null && "value" in entry)
  );
}

function createPixiRuntime() {
  const filters: MockFilter[] = [];
  const createdTextures: MockTexture[] = [];
  const textureCreateOptions: TextureCreateOptions[] = [];
  let glyphUniforms: Record<string, number | Float32Array> | undefined;

  const runtime = {
    Filter: {
      from(options: ExtensionPixiFilterOptions) {
        const resources: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(options.resources ?? {})) {
          if (isUniformGroup(value)) {
            const uniforms = Object.fromEntries(
              Object.entries(value).map(([name, s]) => [name, s.value]),
            ) as Record<string, number | Float32Array>;
            resources[key] = { uniforms };
            if (key === "matrixRainUniforms") glyphUniforms = uniforms;
          } else {
            resources[key] = value;
          }
        }
        const filter: MockFilter = {
          name: options.gl?.name ?? "unnamed",
          resources,
          destroy: vi.fn(),
        };
        filters.push(filter);
        return filter;
      },
    },
    Texture: { WHITE: { source: { style: {} } } },
    RenderTexture: {
      create(dimensions: TextureCreateOptions) {
        textureCreateOptions.push(dimensions);
        const texture: MockTexture = {
          source: { style: {}, width: dimensions.width, height: dimensions.height },
          destroy: vi.fn(),
        };
        createdTextures.push(texture);
        return texture;
      },
    },
  } as unknown as ExtensionPixiRuntime;

  return {
    runtime,
    filters,
    createdTextures,
    textureCreateOptions,
    getLiveUniforms() {
      if (!glyphUniforms) throw new Error("Filter.from was not called");
      return glyphUniforms;
    },
  };
}

function renderSample(
  overrides: Partial<ExtensionFilterRenderSample>,
): ExtensionFilterRenderSample {
  return {
    sequenceId: 0,
    sampleId: 0,
    mode: "preview",
    continuity: "sequential",
    presentationTimeTicks: 0,
    visualTimeTicks: 0,
    sourceTimeTicks: 0,
    deltaTimeTicks: null,
    fps: 30,
    isWarmup: false,
    ...overrides,
  };
}

function applyContext(
  render: ExtensionFilterRenderSample,
  contentSize = { width: 1920, height: 1080 },
): ExtensionTrustedFilterApplyContext {
  return {
    target: {},
    transformId: "matrix-1",
    contentSize,
    render,
  };
}

describe("createMatrixRainFilter", () => {
  it("updates Pixi's live scalar uniforms, output mode, time, and content size", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);

    instance.update(
      {
        ...DEFAULT_MATRIX_RAIN_PARAMETERS,
        size: 24,
        verticalSpacing: 7,
        seed: 77,
        fallSpeed: 13,
        directShapeStrength: 0.4,
        injectionStrength: 0.6,
        ambientSpawn: 0.2,
        darkDamping: 1.5,
        motionInfluence: 1.1,
        outputMode: "matrixOnly",
        debugMode: "rainState",
      },
      applyContext(renderSample({ sampleId: 2, visualTimeTicks: 48_000 })),
    );

    const uniforms = pixi.getLiveUniforms();
    expect(uniforms.uTimeSeconds).toBe(0.5);
    expect(uniforms.uSize).toBe(24);
    expect(uniforms.uVerticalSpacing).toBe(7);
    expect(uniforms.uSeed).toBe(77);
    expect(uniforms.uFallSpeed).toBe(13);
    expect(uniforms.uDirectShapeStrength).toBe(0.4);
    expect(uniforms.uInjectionStrength).toBe(0.6);
    expect(uniforms.uAmbientSpawn).toBe(0.2);
    expect(uniforms.uMotionInfluence).toBe(1.1);
    expect(uniforms.uOutputMode).toBe(1);
    expect(uniforms.uDebugMode).toBe(4);
    expect(Array.from(uniforms.uContentSize as Float32Array)).toEqual([1920, 1080]);
  });

  it("builds a glyph filter and a state filter", () => {
    const pixi = createPixiRuntime();
    createMatrixRainFilter(pixi.runtime, 96_000);
    expect(pixi.filters.map((f) => f.name)).toEqual([
      "example-matrix-rain",
      "example-matrix-rain-state",
    ]);
  });

  it("advances feedback once per new sample and skips repeats", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);
    const glyph = pixi.filters[0];
    const stateFilter = pixi.filters[1];
    const applied: string[] = [];
    const filterManager = {
      applyFilter: (filter: MockFilter) => applied.push(filter.name),
    };
    const input = { source: { width: 100, height: 100 } };
    const runApply = () =>
      (glyph.apply as (...args: unknown[]) => void)(filterManager, input, {}, false);

    // First sample: reset advance -> state pass then glyph pass.
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(renderSample({ sampleId: 10, visualTimeTicks: 0 })),
    );
    runApply();
    expect(applied).toEqual([stateFilter.name, glyph.name]);

    // Repeated same sample (no new update): glyph only, no state advance.
    applied.length = 0;
    runApply();
    expect(applied).toEqual([glyph.name]);

    // New sample: advances again.
    applied.length = 0;
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(renderSample({ sampleId: 11, visualTimeTicks: 3_200 })),
    );
    runApply();
    expect(applied).toEqual([stateFilter.name, glyph.name]);
    // Two textures were allocated once at one texel per source-local cell.
    expect(pixi.createdTextures).toHaveLength(2);
    expect(pixi.textureCreateOptions).toEqual([
      expect.objectContaining({
        width: 192,
        height: 90,
        resolution: 1,
        scaleMode: "linear",
        antialias: false,
        autoGenerateMipmaps: false,
        autoGarbageCollect: false,
      }),
      expect.objectContaining({ width: 192, height: 90 }),
    ]);
  });

  it("reallocates and resets state when the source-local grid changes", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);
    const glyph = pixi.filters[0];
    const stateFilter = pixi.filters[1];
    const applied: string[] = [];
    const filterManager = {
      applyFilter: (filter: MockFilter) => applied.push(filter.name),
    };
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(
        renderSample({ sampleId: 1, visualTimeTicks: 0 }),
        { width: 100, height: 100 },
      ),
    );
    (glyph.apply as (...a: unknown[]) => void)(
      filterManager,
      { source: { width: 100, height: 100 } },
      {},
      false,
    );
    expect(pixi.createdTextures).toHaveLength(2);

    // A different content size reallocates a new cell-grid pair and forces a
    // reset advance even though the logical sample id is unchanged.
    applied.length = 0;
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(
        renderSample({ sampleId: 1, visualTimeTicks: 0 }),
        { width: 200, height: 120 },
      ),
    );
    (glyph.apply as (...a: unknown[]) => void)(
      filterManager,
      { source: { width: 200, height: 120 } },
      {},
      false,
    );
    expect(pixi.createdTextures).toHaveLength(4);
    expect(pixi.textureCreateOptions.slice(0, 2)).toEqual([
      expect.objectContaining({ width: 10, height: 9 }),
      expect.objectContaining({ width: 10, height: 9 }),
    ]);
    expect(pixi.textureCreateOptions.slice(2)).toEqual([
      expect.objectContaining({ width: 20, height: 10 }),
      expect.objectContaining({ width: 20, height: 10 }),
    ]);
    expect(applied).toEqual([stateFilter.name, glyph.name]);
    // The original pair was destroyed on reallocation.
    expect(pixi.createdTextures[0].destroy).toHaveBeenCalledOnce();
  });

  it("recomputes same-sample state edits from the retained prior texture", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);
    const glyph = pixi.filters[0];
    const stateFilter = pixi.filters[1];
    const passes: Array<{ filter: MockFilter; output: unknown }> = [];
    const filterManager = {
      applyFilter: (filter: MockFilter, _input: unknown, output: unknown) => {
        passes.push({ filter, output });
      },
    };
    let input = { source: { style: {}, width: 100, height: 100 } };
    const runApply = () =>
      (glyph.apply as (...args: unknown[]) => void)(filterManager, input, {}, false);

    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(renderSample({ sampleId: 1, visualTimeTicks: 0 })),
    );
    runApply();
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(
        renderSample({
          sampleId: 2,
          visualTimeTicks: 3_200,
          deltaTimeTicks: 3_200,
        }),
      ),
    );
    runApply();

    // After two committed samples, texture 0 is current and texture 1 retains
    // the prior sample. A same-sample feedback edit must overwrite texture 0
    // while continuing to read texture 1; swapping would lose the baseline.
    passes.length = 0;
    instance.update(
      { ...DEFAULT_MATRIX_RAIN_PARAMETERS, sourceInfluence: 0.5 },
      applyContext(
        renderSample({
          sampleId: 2,
          visualTimeTicks: 3_200,
          deltaTimeTicks: 3_200,
        }),
      ),
    );
    runApply();
    expect(passes.map((pass) => pass.filter.name)).toEqual([
      stateFilter.name,
      glyph.name,
    ]);
    expect(passes[0].output).toBe(pixi.createdTextures[0]);
    expect(stateFilter.resources.uPrevState).toBe(
      pixi.createdTextures[1].source,
    );

    // Repeating the recomputed submission is glyph-only, so it cannot inject
    // into its own current state.
    passes.length = 0;
    runApply();
    expect(passes.map((pass) => pass.filter.name)).toEqual([glyph.name]);

    // Replacing the source at the same logical sample also recomputes from the
    // retained prior state, even when the parameter object is unchanged.
    passes.length = 0;
    input = { source: { style: {}, width: 100, height: 100 } };
    runApply();
    expect(passes.map((pass) => pass.filter.name)).toEqual([
      stateFilter.name,
      glyph.name,
    ]);
    expect(passes[0].output).toBe(pixi.createdTextures[0]);
    expect(stateFilter.resources.uPrevState).toBe(
      pixi.createdTextures[1].source,
    );
  });

  it("does not advance feedback for same-sample output-only edits", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);
    const glyph = pixi.filters[0];
    const applied: string[] = [];
    const input = { source: { style: {}, width: 100, height: 100 } };
    const filterManager = {
      applyFilter: (filter: MockFilter) => applied.push(filter.name),
    };

    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(renderSample({ sampleId: 1 })),
    );
    (glyph.apply as (...args: unknown[]) => void)(filterManager, input, {}, false);
    applied.length = 0;
    instance.update(
      { ...DEFAULT_MATRIX_RAIN_PARAMETERS, bodyColor: "#00aa44" },
      applyContext(renderSample({ sampleId: 1 })),
    );
    (glyph.apply as (...args: unknown[]) => void)(filterManager, input, {}, false);
    expect(applied).toEqual([glyph.name]);
  });

  it("destroys its state textures and child filter exactly once", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);
    const glyph = pixi.filters[0];
    const stateFilter = pixi.filters[1];
    instance.update(
      DEFAULT_MATRIX_RAIN_PARAMETERS,
      applyContext(renderSample({ sampleId: 1 })),
    );
    (glyph.apply as (...a: unknown[]) => void)(
      { applyFilter: () => {} },
      { source: { width: 64, height: 64 } },
      {},
      false,
    );

    instance.destroy?.();
    expect(pixi.createdTextures).toHaveLength(2);
    for (const texture of pixi.createdTextures) {
      expect(texture.destroy).toHaveBeenCalledOnce();
    }
    expect(stateFilter.destroy).toHaveBeenCalledOnce();
  });
});
