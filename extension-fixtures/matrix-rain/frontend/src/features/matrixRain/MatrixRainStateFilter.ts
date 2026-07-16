import type { ExtensionPixiRuntime } from "@vlo/extension-sdk";
import {
  MATRIX_RAIN_STATE_FRAGMENT,
  MATRIX_RAIN_STATE_VERTEX,
} from "./shaders/matrixRainStateGl";
import {
  MATRIX_RAIN_STATE_WGSL,
  MATRIX_RAIN_STATE_WGSL_FRAGMENT_ENTRY,
  MATRIX_RAIN_STATE_WGSL_VERTEX_ENTRY,
} from "./shaders/matrixRainStateWgsl";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "./constants";
import {
  accumulationModeIndex,
  motionModeIndex,
  signalModeIndex,
} from "./utils/parameterValidation";

/** Live uniform values of the state-update pass; mutate these each frame. */
export interface StateUniformValues {
  uTimeSeconds: number;
  uDeltaSeconds: number;
  uSize: number;
  uVerticalSpacing: number;
  uSeed: number;
  uFallSpeed: number;
  uSpeedVariation: number;
  uTrailShape: number;
  uPulseDensity: number;
  uHeadWidth: number;
  uSignalMode: number;
  uLumaWeight: number;
  uEdgeWeight: number;
  uEdgeGain: number;
  uAlphaEdgeWeight: number;
  uSignalThreshold: number;
  uSignalGain: number;
  uSignalGamma: number;
  uTrailHalfLife: number;
  uBaseInjection: number;
  uAmbientSpawn: number;
  uSourceInfluence: number;
  uMotionInfluence: number;
  uMotionMode: number;
  uMotionThreshold: number;
  uMotionGain: number;
  uMotionImmediateAmount: number;
  uInjectionStrength: number;
  uDarkDamping: number;
  uAccumulationMode: number;
  uReset: number;
  uContentSize: Float32Array;
  uStateSize: Float32Array;
}

/** Minimal shape of the parts of a host Pixi texture source this uses. */
interface PixiTextureSourceLike {
  readonly style: unknown;
}
interface PixiTextureLike {
  readonly source: PixiTextureSourceLike;
}

export interface MatrixRainStateFilter {
  /** The host Pixi Filter running the state-update program. */
  readonly filter: object;
  /** Live uniform values to update before each state pass. */
  readonly uniforms: StateUniformValues;
  /** Rebind the previous-state texture read by the pass (ping-pong). */
  setPreviousState(texture: PixiTextureLike): void;
}

function scalar(value: number) {
  return { value, type: "f32" as const };
}

/**
 * Build the low-resolution state-update filter: a second host Pixi Filter with
 * matching GLSL/WGSL programs that reads the current input plus the previous
 * state and writes the next RGBA8 state. It is a private child of the top-level
 * Matrix filter, driven from its `apply()` override. The uniform-group key order
 * is the GPU contract shared with the `StateUniforms` WGSL struct — do not
 * reorder without updating the struct.
 */
export function createMatrixRainStateFilter(
  pixi: ExtensionPixiRuntime,
): MatrixRainStateFilter {
  const d = DEFAULT_MATRIX_RAIN_PARAMETERS;
  const uniformStructures = {
    uTimeSeconds: scalar(0),
    uDeltaSeconds: scalar(0),
    uSize: scalar(d.size),
    uVerticalSpacing: scalar(d.verticalSpacing),
    uSeed: scalar(d.seed),
    uFallSpeed: scalar(d.fallSpeed),
    uSpeedVariation: scalar(d.speedVariation),
    uTrailShape: scalar(d.trailShape),
    uPulseDensity: scalar(d.pulseDensity),
    uHeadWidth: scalar(d.headWidth),
    uSignalMode: scalar(signalModeIndex(d.signalMode)),
    uLumaWeight: scalar(d.lumaWeight),
    uEdgeWeight: scalar(d.edgeWeight),
    uEdgeGain: scalar(d.edgeGain),
    uAlphaEdgeWeight: scalar(d.alphaEdgeWeight),
    uSignalThreshold: scalar(d.signalThreshold),
    uSignalGain: scalar(d.signalGain),
    uSignalGamma: scalar(d.signalGamma),
    uTrailHalfLife: scalar(d.trailHalfLife),
    uBaseInjection: scalar(d.baseInjection),
    uAmbientSpawn: scalar(d.ambientSpawn),
    uSourceInfluence: scalar(d.sourceInfluence),
    uMotionInfluence: scalar(d.motionInfluence),
    uMotionMode: scalar(motionModeIndex(d.motionMode)),
    uMotionThreshold: scalar(d.motionThreshold),
    uMotionGain: scalar(d.motionGain),
    uMotionImmediateAmount: scalar(d.motionImmediateAmount),
    uInjectionStrength: scalar(d.injectionStrength),
    uDarkDamping: scalar(d.darkDamping),
    uAccumulationMode: scalar(accumulationModeIndex(d.accumulationMode)),
    uReset: scalar(1),
    uContentSize: { value: new Float32Array(2), type: "vec2<f32>" as const },
    uStateSize: { value: new Float32Array(2), type: "vec2<f32>" as const },
  };

  // A placeholder previous-state texture so the bind group is complete at
  // construction; the controller rebinds it to a real state texture each frame.
  const whiteTexture = (pixi as unknown as { Texture: { WHITE: PixiTextureLike } })
    .Texture.WHITE;

  const filter = pixi.Filter.from({
    gl: {
      name: "example-matrix-rain-state",
      vertex: MATRIX_RAIN_STATE_VERTEX,
      fragment: MATRIX_RAIN_STATE_FRAGMENT,
    },
    gpu: {
      vertex: {
        source: MATRIX_RAIN_STATE_WGSL,
        entryPoint: MATRIX_RAIN_STATE_WGSL_VERTEX_ENTRY,
      },
      fragment: {
        source: MATRIX_RAIN_STATE_WGSL,
        entryPoint: MATRIX_RAIN_STATE_WGSL_FRAGMENT_ENTRY,
      },
    },
    resources: {
      stateUniforms: uniformStructures,
      uPrevState: whiteTexture.source,
      uPrevStateSampler: whiteTexture.source.style,
    },
    clipToViewport: false,
    // Feedback data, not colour: never premultiply or blend the state pass.
    blendMode: "none",
  }) as {
    resources: {
      readonly stateUniforms: { readonly uniforms: StateUniformValues };
      uPrevState: PixiTextureSourceLike;
    };
  };

  const uniforms = filter.resources.stateUniforms.uniforms;

  return {
    filter: filter as object,
    uniforms,
    setPreviousState(texture: PixiTextureLike) {
      filter.resources.uPrevState = texture.source;
    },
  };
}
