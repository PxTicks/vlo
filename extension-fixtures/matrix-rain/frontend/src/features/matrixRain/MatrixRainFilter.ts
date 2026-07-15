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
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "./constants";
import {
  debugModeIndex,
  outputModeIndex,
  resolveMatrixRainParameters,
} from "./utils/parameterValidation";
import { colorToVec3 } from "./utils/matrixRainMath";

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

interface MatrixRainUniformValues {
  uTimeSeconds: number;
  uSize: number;
  uSeed: number;
  uGlyphCycleRate: number;
  uFallSpeed: number;
  uSpeedVariation: number;
  uTrailShape: number;
  uPulseDensity: number;
  uHeadWidth: number;
  uRainStrength: number;
  uHeadIntensity: number;
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

interface MatrixRainFilterObject {
  readonly resources: {
    readonly matrixRainUniforms: {
      readonly uniforms: MatrixRainUniformValues;
    };
  };
}

/**
 * Phase 2 controller: one host `Filter` carrying matching GLSL and WGSL programs
 * for the stateless Matrix appearance. The uniform-group key order is the GPU
 * contract shared with the WGSL struct in `matrixRainWgsl.ts` — do not reorder
 * without updating the struct.
 *
 * The appearance is a pure function of the render sample's `visualTimeTicks`, so
 * repeated renders of one logical sample are identical and there is no
 * per-frame CPU grid iteration or texture allocation. `clipToViewport` is
 * disabled so the local glyph grid stays anchored to the input bounds as a clip
 * crosses the viewport.
 */
export function createMatrixRainFilter(
  pixi: ExtensionPixiRuntime,
  ticksPerSecond: number,
): ExtensionTrustedFilterInstance {
  const d = DEFAULT_MATRIX_RAIN_PARAMETERS;
  // Insertion order MUST match the MatrixRainUniforms WGSL struct field order.
  const uniformStructures = {
    uTimeSeconds: scalar(0),
    uSize: scalar(d.size),
    uSeed: scalar(d.seed),
    uGlyphCycleRate: scalar(d.glyphCycleRate),
    uFallSpeed: scalar(d.fallSpeed),
    uSpeedVariation: scalar(d.speedVariation),
    uTrailShape: scalar(d.trailShape),
    uPulseDensity: scalar(d.pulseDensity),
    uHeadWidth: scalar(d.headWidth),
    uRainStrength: scalar(d.rainStrength),
    uHeadIntensity: scalar(d.headIntensity),
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

  const safeTicksPerSecond =
    Number.isFinite(ticksPerSecond) && ticksPerSecond > 0
      ? ticksPerSecond
      : 96_000;
  const reductionTicks = TIME_REDUCTION_SECONDS * safeTicksPerSecond;

  const object = pixi.Filter.from({
    gl: {
      name: "example-matrix-rain",
      vertex: MATRIX_RAIN_VERTEX,
      fragment: MATRIX_RAIN_FRAGMENT,
    },
    gpu: {
      vertex: {
        source: MATRIX_RAIN_WGSL,
        entryPoint: MATRIX_RAIN_WGSL_VERTEX_ENTRY,
      },
      fragment: {
        source: MATRIX_RAIN_WGSL,
        entryPoint: MATRIX_RAIN_WGSL_FRAGMENT_ENTRY,
      },
    },
    resources: { matrixRainUniforms: uniformStructures },
    clipToViewport: false,
  }) as MatrixRainFilterObject;
  // Pixi copies primitive descriptor values when it creates a UniformGroup.
  // Update the live resource, not `uniformStructures`: array-backed colours
  // otherwise appear to work while every scalar remains stuck at its default.
  const uniforms = object.resources.matrixRainUniforms.uniforms;

  const writeColor = (target: Float32Array, hex: string) => {
    const [r, g, b] = colorToVec3(hex);
    target[0] = r;
    target[1] = g;
    target[2] = b;
  };

  return {
    object,
    update(parameters, context) {
      const resolved = resolveMatrixRainParameters(parameters);
      // Fail closed: a non-finite/out-of-range value never reaches a uniform;
      // keep the last good state rather than corrupt the render.
      if (!resolved) return;

      const visualTicks = context.render?.visualTimeTicks ?? 0;
      const reduced =
        ((visualTicks % reductionTicks) + reductionTicks) % reductionTicks;
      uniforms.uTimeSeconds = reduced / safeTicksPerSecond;

      uniforms.uSize = resolved.size;
      uniforms.uSeed = resolved.seed;
      uniforms.uGlyphCycleRate = resolved.glyphCycleRate;
      uniforms.uFallSpeed = resolved.fallSpeed;
      uniforms.uSpeedVariation = resolved.speedVariation;
      uniforms.uTrailShape = resolved.trailShape;
      uniforms.uPulseDensity = resolved.pulseDensity;
      uniforms.uHeadWidth = resolved.headWidth;
      uniforms.uRainStrength = resolved.rainStrength;
      uniforms.uHeadIntensity = resolved.headIntensity;
      uniforms.uDitherMagnitude = resolved.ditherMagnitude;
      uniforms.uOutputMode = outputModeIndex(resolved.outputMode);
      uniforms.uDebugMode = debugModeIndex(resolved.debugMode);

      const contentWidth = context.contentSize?.width ?? 0;
      const contentHeight = context.contentSize?.height ?? 0;
      uniforms.uContentSize[0] =
        Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
      uniforms.uContentSize[1] =
        Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;

      writeColor(uniforms.uBackground, resolved.backgroundColor);
      writeColor(uniforms.uShadow, resolved.shadowColor);
      writeColor(uniforms.uBody, resolved.bodyColor);
      writeColor(uniforms.uBright, resolved.brightColor);
      writeColor(uniforms.uHead, resolved.headColor);
    },
  };
}
