import type {
  ExtensionPixiRuntime,
  ExtensionTrustedFilterInstance,
} from "@vlo/extension-sdk";
import { MATRIX_RAIN_FRAGMENT, MATRIX_RAIN_VERTEX } from "./shaders/matrixRainGl";
import {
  MATRIX_RAIN_WGSL,
  MATRIX_RAIN_WGSL_FRAGMENT_ENTRY,
  MATRIX_RAIN_WGSL_VERTEX_ENTRY,
} from "./shaders/matrixRainWgsl";
import {
  createMatrixRainStateFilter,
  type MatrixRainStateFilter,
} from "./MatrixRainStateFilter";
import { DEFAULT_MATRIX_RAIN_PARAMETERS, MATRIX_RAIN_RENDERING } from "./constants";
import {
  debugModeIndex,
  outputModeIndex,
  resolveMatrixRainParameters,
} from "./utils/parameterValidation";
import { colorToVec3 } from "./utils/matrixRainMath";
import {
  calculateStateGridSize,
  stateNeedsReallocation,
  stateTopologyChanged,
  type StateTopology,
} from "./utils/feedbackLifecycle";
import type { MatrixRainParameters } from "./types";

/** Bound the visual-time magnitude so shader float precision stays stable over
 *  long timelines. Reduction uses integer ticks, so it is exact and
 *  deterministic across preview and export. */
const TIME_REDUCTION_SECONDS = 100_000;

function scalar(value: number) {
  return { value, type: "f32" as const };
}
function color(hex: string) {
  return { value: new Float32Array(colorToVec3(hex)), type: "vec3<f32>" as const };
}

interface GlyphUniformValues {
  uTimeSeconds: number;
  uSize: number;
  uVerticalSpacing: number;
  uSeed: number;
  uGlyphCycleRate: number;
  uFallSpeed: number;
  uSpeedVariation: number;
  uTrailShape: number;
  uPulseDensity: number;
  uHeadWidth: number;
  uRainStrength: number;
  uHeadIntensity: number;
  uDirectShapeStrength: number;
  uDitherMagnitude: number;
  uOutputMode: number;
  uDebugMode: number;
  uContentSize: Float32Array;
  uBackground: Float32Array;
  uShadow: Float32Array;
  uBody: Float32Array;
  uBright: Float32Array;
  uHead: Float32Array;
}

// --- Minimal host-Pixi shapes this controller depends on (all injected). -----
interface PixiTextureSourceLike {
  readonly style: unknown;
  readonly width: number;
  readonly height: number;
  readonly destroyed?: boolean;
}
interface RenderTextureLike {
  readonly source: PixiTextureSourceLike;
  destroy(destroySource?: boolean): void;
}
interface FilterManagerLike {
  applyFilter(filter: object, input: unknown, output: unknown, clear: boolean): void;
}
interface FilterInputLike {
  readonly source: PixiTextureSourceLike;
}
type FilterApply = (
  filterManager: FilterManagerLike,
  input: FilterInputLike,
  output: unknown,
  clearMode: boolean,
) => void;
interface GlyphFilterObject {
  apply: FilterApply;
  resources: {
    uState: unknown;
    readonly matrixRainUniforms: { readonly uniforms: GlyphUniformValues };
  };
}

/** Latest render sample and resolved parameters captured by `update()`. */
interface PendingSample {
  params: MatrixRainParameters;
  timeSeconds: number;
  sampleId: number;
  sequenceId: number;
  continuity: string;
  deltaTicks: number | null;
  visualTimeTicks: number;
  contentWidth: number;
  contentHeight: number;
}

const MAX_STEP_SECONDS = MATRIX_RAIN_RENDERING.maxStepSeconds ?? 1 / 30;

/** Only fields consumed by the state pass belong here. Palette/composition
 * edits can re-render the glyph pass without touching feedback history. */
function stateParameterSignature(sample: PendingSample): string {
  const p = sample.params;
  return [
    sample.timeSeconds,
    p.size,
    p.verticalSpacing,
    p.seed,
    p.fallSpeed,
    p.speedVariation,
    p.trailShape,
    p.pulseDensity,
    p.headWidth,
    p.trailHalfLife,
    p.baseInjection,
    p.sourceInfluence,
  ].join("|");
}

/**
 * Phase 3 controller: a top-level glyph `Filter` whose `apply()` is overridden
 * to drive a two-pass, source-aware temporal feedback effect. It owns a
 * low-resolution state-update child filter and two persistent RGBA8 ping-pong
 * state textures. Each new logical sample advances the feedback once (decay +
 * downward advection + luma injection); repeated/paused samples re-render from
 * the current state without advancing it. GPU state changes happen only inside
 * `apply()`, where the real source input and Pixi's FilterSystem are available.
 */
export function createMatrixRainFilter(
  pixi: ExtensionPixiRuntime,
  ticksPerSecond: number,
): ExtensionTrustedFilterInstance {
  const d = DEFAULT_MATRIX_RAIN_PARAMETERS;
  // Insertion order MUST match the MatrixRainUniforms WGSL struct field order.
  const glyphUniformStructures = {
    uTimeSeconds: scalar(0),
    uSize: scalar(d.size),
    uVerticalSpacing: scalar(d.verticalSpacing),
    uSeed: scalar(d.seed),
    uGlyphCycleRate: scalar(d.glyphCycleRate),
    uFallSpeed: scalar(d.fallSpeed),
    uSpeedVariation: scalar(d.speedVariation),
    uTrailShape: scalar(d.trailShape),
    uPulseDensity: scalar(d.pulseDensity),
    uHeadWidth: scalar(d.headWidth),
    uRainStrength: scalar(d.rainStrength),
    uHeadIntensity: scalar(d.headIntensity),
    uDirectShapeStrength: scalar(d.directShapeStrength),
    uDitherMagnitude: scalar(d.ditherMagnitude),
    uOutputMode: scalar(outputModeIndex(d.outputMode)),
    uDebugMode: scalar(debugModeIndex(d.debugMode)),
    uContentSize: { value: new Float32Array(2), type: "vec2<f32>" as const },
    uBackground: color(d.backgroundColor),
    uShadow: color(d.shadowColor),
    uBody: color(d.bodyColor),
    uBright: color(d.brightColor),
    uHead: color(d.headColor),
  };

  const runtime = pixi as unknown as {
    Texture: { WHITE: { source: PixiTextureSourceLike } };
    RenderTexture: {
      create(options: {
        width: number;
        height: number;
        resolution: number;
        scaleMode: "linear";
        antialias: boolean;
        autoGenerateMipmaps: boolean;
        autoGarbageCollect: boolean;
      }): RenderTextureLike;
    };
  };

  const glyphFilter = pixi.Filter.from({
    gl: {
      name: "example-matrix-rain",
      vertex: MATRIX_RAIN_VERTEX,
      fragment: MATRIX_RAIN_FRAGMENT,
    },
    gpu: {
      vertex: { source: MATRIX_RAIN_WGSL, entryPoint: MATRIX_RAIN_WGSL_VERTEX_ENTRY },
      fragment: { source: MATRIX_RAIN_WGSL, entryPoint: MATRIX_RAIN_WGSL_FRAGMENT_ENTRY },
    },
    resources: {
      matrixRainUniforms: glyphUniformStructures,
      uState: runtime.Texture.WHITE.source,
      uStateSampler: runtime.Texture.WHITE.source.style,
    },
    clipToViewport: false,
  }) as unknown as GlyphFilterObject;

  const glyphUniforms = glyphFilter.resources.matrixRainUniforms.uniforms;
  const state: MatrixRainStateFilter = createMatrixRainStateFilter(pixi);

  const safeTicksPerSecond =
    Number.isFinite(ticksPerSecond) && ticksPerSecond > 0 ? ticksPerSecond : 96_000;
  const reductionTicks = TIME_REDUCTION_SECONDS * safeTicksPerSecond;

  // --- Persistent ping-pong state (one RGBA8 texel per glyph cell). ----------
  const textures: (RenderTextureLike | null)[] = [null, null];
  let currentIndex = 0;
  let allocation: { width: number; height: number } | null = null;
  let lastTopology: StateTopology | null = null;
  let lastAdvancedSampleId: number | null = null;
  let lastSequenceId: number | null = null;
  let lastVisualTimeTicks = 0;
  let lastStateSignature: string | null = null;
  let lastInputSource: PixiTextureSourceLike | null = null;
  let lastAdvanceDeltaSeconds = 0;
  let lastAdvanceWasReset = true;

  let pending: PendingSample | null = null;

  const writeColor = (target: Float32Array, hex: string) => {
    const [r, g, b] = colorToVec3(hex);
    target[0] = r;
    target[1] = g;
    target[2] = b;
  };

  const destroyTextures = () => {
    for (let i = 0; i < textures.length; i += 1) {
      textures[i]?.destroy(true);
      textures[i] = null;
    }
    allocation = null;
    lastTopology = null;
    lastAdvancedSampleId = null;
    lastSequenceId = null;
    lastStateSignature = null;
    lastInputSource = null;
    lastAdvanceDeltaSeconds = 0;
    lastAdvanceWasReset = true;
  };

  const ensureAllocation = (width: number, height: number): boolean => {
    const texturesAreLive = textures.every(
      (texture) => texture !== null && texture.source.destroyed !== true,
    );
    if (texturesAreLive && !stateNeedsReallocation(allocation, width, height)) {
      return false;
    }
    destroyTextures();
    const options = {
      width,
      height,
      resolution: 1,
      scaleMode: "linear" as const,
      antialias: false,
      autoGenerateMipmaps: false,
      autoGarbageCollect: false,
    };
    textures[0] = runtime.RenderTexture.create(options);
    textures[1] = runtime.RenderTexture.create(options);
    allocation = { width, height };
    currentIndex = 0;
    return true;
  };

  glyphFilter.apply = (filterManager, input, output, clearMode) => {
    const sample = pending;
    if (!sample) {
      // No host update yet: passthrough via the (state-less) glyph program.
      filterManager.applyFilter(glyphFilter, input, output, clearMode);
      return;
    }

    try {
      const contentWidth =
        sample.contentWidth > 0
          ? sample.contentWidth
          : Math.max(1, Math.floor(input.source.width));
      const contentHeight =
        sample.contentHeight > 0
          ? sample.contentHeight
          : Math.max(1, Math.floor(input.source.height));
      const gridSize = calculateStateGridSize(
        contentWidth,
        contentHeight,
        sample.params.size,
        sample.params.verticalSpacing,
      );
      const reallocated = ensureAllocation(gridSize.width, gridSize.height);

      const topology: StateTopology = {
        width: contentWidth,
        height: contentHeight,
        size: sample.params.size,
        verticalSpacing: sample.params.verticalSpacing,
      };
      const discontinuous =
        sample.continuity === "discontinuous" ||
        lastSequenceId !== sample.sequenceId;
      const reset =
        reallocated ||
        lastAdvancedSampleId === null ||
        discontinuous ||
        stateTopologyChanged(lastTopology, topology);

      const signature = stateParameterSignature(sample);
      const sameLogicalSample =
        !reset &&
        sample.sampleId === lastAdvancedSampleId &&
        sample.sequenceId === lastSequenceId;
      const recompute =
        sameLogicalSample &&
        (signature !== lastStateSignature || input.source !== lastInputSource);

      // Repeated submissions render without accumulating. An edit at the same
      // sample recomputes from the retained prior texture, never from the
      // already-computed current texture.
      const advance =
        reset || sample.sampleId !== lastAdvancedSampleId || recompute;
      if (advance) {
        let deltaSeconds: number;
        if (reset) {
          deltaSeconds = 0;
        } else if (recompute) {
          deltaSeconds = lastAdvanceDeltaSeconds;
        } else if (sample.deltaTicks !== null) {
          deltaSeconds = Math.max(0, sample.deltaTicks) / safeTicksPerSecond;
        } else {
          deltaSeconds =
            (sample.visualTimeTicks - lastVisualTimeTicks) / safeTicksPerSecond;
        }
        deltaSeconds = Math.min(Math.max(deltaSeconds, 0), MAX_STEP_SECONDS);

        const su = state.uniforms;
        su.uTimeSeconds = sample.timeSeconds;
        su.uDeltaSeconds = deltaSeconds;
        su.uSize = sample.params.size;
        su.uVerticalSpacing = sample.params.verticalSpacing;
        su.uSeed = sample.params.seed;
        su.uFallSpeed = sample.params.fallSpeed;
        su.uSpeedVariation = sample.params.speedVariation;
        su.uTrailShape = sample.params.trailShape;
        su.uPulseDensity = sample.params.pulseDensity;
        su.uHeadWidth = sample.params.headWidth;
        su.uTrailHalfLife = sample.params.trailHalfLife;
        su.uBaseInjection = sample.params.baseInjection;
        su.uSourceInfluence = sample.params.sourceInfluence;
        const statePassReset = reset || (recompute && lastAdvanceWasReset);
        su.uReset = statePassReset ? 1 : 0;
        su.uContentSize[0] = contentWidth;
        su.uContentSize[1] = contentHeight;
        su.uStateSize[0] = gridSize.width;
        su.uStateSize[1] = gridSize.height;

        const inactiveIndex = currentIndex === 0 ? 1 : 0;
        const readTexture = textures[recompute ? inactiveIndex : currentIndex]!;
        const writeTexture = textures[recompute ? currentIndex : inactiveIndex]!;
        state.setPreviousState(readTexture);
        filterManager.applyFilter(state.filter, input, writeTexture, true);
        if (!recompute) currentIndex = inactiveIndex;

        lastAdvancedSampleId = sample.sampleId;
        lastSequenceId = sample.sequenceId;
        lastVisualTimeTicks = sample.visualTimeTicks;
        lastTopology = topology;
        lastStateSignature = signature;
        lastInputSource = input.source;
        lastAdvanceDeltaSeconds = deltaSeconds;
        lastAdvanceWasReset = statePassReset;
      }

      glyphFilter.resources.uState = textures[currentIndex]!.source;
      filterManager.applyFilter(glyphFilter, input, output, clearMode);
    } catch {
      // Fail safe: never break the host render. Fall back to a single glyph
      // pass using whatever state is currently bound.
      filterManager.applyFilter(glyphFilter, input, output, clearMode);
    }
  };

  return {
    object: glyphFilter as unknown as object,
    update(parameters, context) {
      const resolved = resolveMatrixRainParameters(parameters);
      // Fail closed: a non-finite/out-of-range value never reaches a uniform.
      if (!resolved) return;

      const visualTicks = context.render?.visualTimeTicks ?? 0;
      const reduced =
        ((visualTicks % reductionTicks) + reductionTicks) % reductionTicks;
      const timeSeconds = reduced / safeTicksPerSecond;

      // Update the glyph program's uniforms (the render pass) immediately.
      glyphUniforms.uTimeSeconds = timeSeconds;
      glyphUniforms.uSize = resolved.size;
      glyphUniforms.uVerticalSpacing = resolved.verticalSpacing;
      glyphUniforms.uSeed = resolved.seed;
      glyphUniforms.uGlyphCycleRate = resolved.glyphCycleRate;
      glyphUniforms.uFallSpeed = resolved.fallSpeed;
      glyphUniforms.uSpeedVariation = resolved.speedVariation;
      glyphUniforms.uTrailShape = resolved.trailShape;
      glyphUniforms.uPulseDensity = resolved.pulseDensity;
      glyphUniforms.uHeadWidth = resolved.headWidth;
      glyphUniforms.uRainStrength = resolved.rainStrength;
      glyphUniforms.uHeadIntensity = resolved.headIntensity;
      glyphUniforms.uDirectShapeStrength = resolved.directShapeStrength;
      glyphUniforms.uDitherMagnitude = resolved.ditherMagnitude;
      glyphUniforms.uOutputMode = outputModeIndex(resolved.outputMode);
      glyphUniforms.uDebugMode = debugModeIndex(resolved.debugMode);

      const contentWidth = context.contentSize?.width ?? 0;
      const contentHeight = context.contentSize?.height ?? 0;
      const safeContentWidth =
        Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
      const safeContentHeight =
        Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
      glyphUniforms.uContentSize[0] = safeContentWidth;
      glyphUniforms.uContentSize[1] = safeContentHeight;

      writeColor(glyphUniforms.uBackground, resolved.backgroundColor);
      writeColor(glyphUniforms.uShadow, resolved.shadowColor);
      writeColor(glyphUniforms.uBody, resolved.bodyColor);
      writeColor(glyphUniforms.uBright, resolved.brightColor);
      writeColor(glyphUniforms.uHead, resolved.headColor);

      const render = context.render;
      pending = {
        params: resolved,
        timeSeconds,
        sampleId: render?.sampleId ?? 0,
        sequenceId: render?.sequenceId ?? 0,
        continuity: render?.continuity ?? "initial",
        deltaTicks: render?.deltaTimeTicks ?? null,
        visualTimeTicks: visualTicks,
        contentWidth: safeContentWidth,
        contentHeight: safeContentHeight,
      };
    },
    destroy() {
      // The host destroys the returned top-level glyph filter; release only the
      // extra resources this instance owns.
      destroyTextures();
      (state.filter as { destroy?: () => void }).destroy?.();
    },
  };
}
