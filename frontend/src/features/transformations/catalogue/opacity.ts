/**
 * opacity.ts
 *
 * Clip-level opacity. Modelled as an always-visible default transform in the
 * Display section, beside Blend Mode. The handler only resolves the value onto
 * `state.opacity`; `applyClipTransforms` realizes it as one AlphaFilter op
 * appended after the clip's whole effect stack.
 *
 * Why a trailing filter rather than `sprite.alpha`: PixiJS applies a display
 * object's own alpha while drawing it into its filter input, i.e. *before* its
 * filters run, so an effect that writes opaque pixels (Dot, ASCII, CRT, ...)
 * would discard it. Appending the op after the effects fades what they
 * produced, and it survives the offscreen effect-mask bake, which drops the
 * transform filters. A fully opaque clip pushes no filter, so the default
 * costs no render pass.
 */

import type { ClipTransform } from "../../../types/TimelineTypes";
import type { ScalarParameter } from "../types";
import { resolveScalar } from "../utils/resolveScalar";
import type {
  TransformHandler,
  TransformState,
  TransformationDefinition,
} from "./types";

export const DEFAULT_OPACITY = 1;

interface OpacityParams {
  opacity?: ScalarParameter;
  [key: string]: unknown;
}

const opacityHandler: TransformHandler<ClipTransform> = (
  state: TransformState,
  transform: ClipTransform,
  context,
) => {
  const { opacity } = transform.parameters as OpacityParams;
  const value = resolveScalar(opacity, context.time ?? 0, DEFAULT_OPACITY);
  // Spline overshoot can leave [0, 1]; a non-finite value renders opaque.
  const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;
  state.opacity = (state.opacity ?? DEFAULT_OPACITY) * clamped;
};

export const opacityDefinition: TransformationDefinition = {
  type: "opacity",
  label: "Opacity",
  compatibleClips: "visual",
  handler: opacityHandler,
  uiConfig: {
    groups: [
      {
        id: "opacity",
        title: "OPACITY",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Opacity",
            name: "opacity",
            defaultValue: DEFAULT_OPACITY,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
