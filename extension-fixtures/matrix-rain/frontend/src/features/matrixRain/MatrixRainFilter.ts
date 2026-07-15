import type {
  ExtensionPixiRuntime,
  ExtensionTrustedFilterInstance,
} from "@vlo/extension-sdk";
import { MATRIX_RAIN_FRAGMENT, MATRIX_RAIN_VERTEX } from "./shaders/matrixRainGl";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "./constants";
import {
  colorToVec3,
  resolveMatrixRainParameters,
} from "./utils/parameterValidation";

/**
 * Phase 0 baseline controller. It constructs one host `Filter` from the injected
 * Pixi singleton and updates its uniforms from host-resolved parameters. The
 * render-sample context is available on `update` but is intentionally unused at
 * this phase — later phases drive multi-pass feedback from it inside a custom
 * `apply()` override. `clipToViewport` is disabled so the (future) glyph grid's
 * origin stays anchored to the input bounds as a clip crosses the viewport.
 */
export function createMatrixRainFilter(
  pixi: ExtensionPixiRuntime,
): ExtensionTrustedFilterInstance {
  const background = colorToVec3(DEFAULT_MATRIX_RAIN_PARAMETERS.backgroundColor);
  const uniforms = {
    uDebugTint: {
      value: DEFAULT_MATRIX_RAIN_PARAMETERS.debugTint,
      type: "f32",
    },
    uBackgroundColor: {
      value: new Float32Array(background),
      type: "vec3<f32>",
    },
  };

  const object = pixi.Filter.from({
    gl: {
      name: "example-matrix-rain",
      vertex: MATRIX_RAIN_VERTEX,
      fragment: MATRIX_RAIN_FRAGMENT,
    },
    resources: { matrixRainUniforms: uniforms },
    clipToViewport: false,
  });

  return {
    object,
    update(parameters) {
      const resolved = resolveMatrixRainParameters(parameters);
      // Fail closed: a non-finite/out-of-range value never reaches a uniform;
      // keep the last good state rather than corrupt the render.
      if (!resolved) return;
      uniforms.uDebugTint.value = resolved.debugTint;
      const [r, g, b] = colorToVec3(resolved.backgroundColor);
      const color = uniforms.uBackgroundColor.value;
      color[0] = r;
      color[1] = g;
      color[2] = b;
    },
  };
}
