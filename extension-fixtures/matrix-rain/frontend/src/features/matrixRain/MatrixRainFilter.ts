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
  const uniforms = {
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
    resources: { matrixRainUniforms: uniforms },
    clipToViewport: false,
  });

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
      uniforms.uTimeSeconds.value = reduced / safeTicksPerSecond;

      uniforms.uSize.value = resolved.size;
      uniforms.uSeed.value = resolved.seed;
      uniforms.uGlyphCycleRate.value = resolved.glyphCycleRate;
      uniforms.uFallSpeed.value = resolved.fallSpeed;
      uniforms.uSpeedVariation.value = resolved.speedVariation;
      uniforms.uTrailShape.value = resolved.trailShape;
      uniforms.uPulseDensity.value = resolved.pulseDensity;
      uniforms.uHeadWidth.value = resolved.headWidth;
      uniforms.uRainStrength.value = resolved.rainStrength;
      uniforms.uHeadIntensity.value = resolved.headIntensity;
      uniforms.uDitherMagnitude.value = resolved.ditherMagnitude;
      uniforms.uOutputMode.value = outputModeIndex(resolved.outputMode);
      uniforms.uDebugMode.value = debugModeIndex(resolved.debugMode);

      writeColor(uniforms.uBackground.value, resolved.backgroundColor);
      writeColor(uniforms.uShadow.value, resolved.shadowColor);
      writeColor(uniforms.uBody.value, resolved.bodyColor);
      writeColor(uniforms.uBright.value, resolved.brightColor);
      writeColor(uniforms.uHead.value, resolved.headColor);
    },
  };
}
