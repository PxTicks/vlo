/**
 * layoutDefinition.ts
 *
 * Unified layout transformation definition that aggregates position, scale,
 * rotation and skew.
 * This is the single source of truth for all layout-related transformations.
 */

import type {
  ClipTransformTarget,
  TransformState,
  TransformHandler,
  TransformationDefinition,
  TransformContext,
  Size,
} from "../types";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import { positionHandler } from "./position";
import { scaleHandler } from "./scale";
import { rotationHandler } from "./rotation";
import { skewHandler } from "./skew";
import { TemplateRegistry } from "./templates/index";

// =============================================================================
// DEFAULTS
// =============================================================================

/**
 * Calculates the default "base" layout for a clip and provides
 * the recipe (apply function) to render that state to a sprite.
 *
 * Uses the "contain" template by default.
 */
export const getBaseLayout = (containerSize: Size, contentSize: Size, mode: string = "contain") => {
  const template = TemplateRegistry[mode] ?? TemplateRegistry["contain"];
  const defaults = template({ container: containerSize, content: contentSize });

  // Return only layout-related defaults
  return {
    scaleX: 1,
    scaleY: 1,
    x: containerSize.width / 2,
    y: containerSize.height / 2,
    rotation: 0,
    skewX: 0,
    skewY: 0,
    ...defaults,
  };
};

/**
 * Pixi `scale` and `skew` that draw a CSS-style shear.
 *
 * Layout skew is a true shear, local matrix R·K·S with K = [[1, tan x],
 * [tan y, 1]]: sliding the top edge keeps the height. Pixi's `skew` instead
 * rotates each local axis, which also shortens it by cos(angle), so the same
 * matrix needs Pixi skew = the shear angles and scale lengthened by 1/cos of
 * the other axis's angle. Rotation is untouched, so `target.rotation` stays the
 * layout rotation for the gizmo and mask followers.
 */
export function resolvePixiSkewedScale(
  scaleX: number,
  scaleY: number,
  skewX: number,
  skewY: number,
): { scaleX: number; scaleY: number } {
  return {
    scaleX: skewY === 0 ? scaleX : scaleX / Math.cos(skewY),
    scaleY: skewX === 0 ? scaleY : scaleY / Math.cos(skewX),
  };
}

export const layoutApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
) => {
  const skewX = state.skewX ?? 0;
  const skewY = state.skewY ?? 0;
  const scale = resolvePixiSkewedScale(state.scaleX, state.scaleY, skewX, skewY);
  target.anchor?.set(0.5);
  target.position.set(state.x, state.y);
  target.scale.set(scale.scaleX, scale.scaleY);
  target.rotation = state.rotation;
  target.skew?.set(skewX, skewY);
};

// =============================================================================
// COMPOSITE HANDLER
// =============================================================================

/**
 * Composite layout handler that dispatches to the appropriate sub-handler
 * based on transform type.
 */
const layoutHandler: TransformHandler<ClipTransform> = (
  state: TransformState,
  transform: ClipTransform,
  context: TransformContext,
) => {
  switch (transform.type) {
    case "position":
      // Type assertion is safe here because we've verified the type
      positionHandler(
        state,
        transform as unknown as import("../../types").PositionTransform,
        context,
      );
      break;
    case "scale":
      scaleHandler(
        state,
        transform as unknown as import("../../types").ScaleTransform,
        context,
      );
      break;
    case "rotation":
      rotationHandler(
        state,
        transform as unknown as import("../../types").RotationTransform,
        context,
      );
      break;
    case "skew":
      skewHandler(
        state,
        transform as unknown as import("../../types").SkewTransform,
        context,
      );
      break;
  }
};

// =============================================================================
// DEFINITION
// =============================================================================

const DEGREES_TO_RADIANS = {
  toModel: (val: unknown) => ((val as number) * Math.PI) / 180,
  toView: (val: unknown) => ((val as number) * 180) / Math.PI,
};

/**
 * The unified layout transformation definition.
 *
 * This definition handles position, scale, rotation and skew as a single
 * logical group.
 * The UI renders separate control groups for each sub-transformation.
 */
export const layoutDefinition: TransformationDefinition = {
  type: "layout",
  label: "Layout",
  compatibleClips: "visual",
  adjustmentCompatible: true,
  handledTypes: ["position", "scale", "rotation", "skew"],
  handler: layoutHandler,
  uiConfig: {
    groups: [
      {
        id: "position",
        title: "POSITION (PX)",
        columns: "1fr 32px 1fr",
        controls: [
          {
            type: "number",
            label: "X",
            name: "x",
            defaultValue: 0,
            supportsSpline: true,
            min: -2000,
            max: 2000,
            softMin: -500,
            softMax: 500,
          },
          { type: "spacer", label: "", name: "_", defaultValue: null },
          {
            type: "number",
            label: "Y",
            name: "y",
            defaultValue: 0,
            supportsSpline: true,
            min: -2000,
            max: 2000,
            softMin: -500,
            softMax: 500,
          },
        ],
      },
      {
        id: "scale",
        title: "SCALE (Multiplier)",
        columns: "1fr 32px 1fr",
        controls: [
          {
            type: "number",
            label: "X",
            name: "x",
            defaultValue: 1,
            step: 0.1,
            supportsSpline: true,
            min: -10,
            max: 10,
            softMin: -4,
            softMax: 4,
          },
          { type: "link", label: "Link", name: "isLinked", defaultValue: true },
          {
            type: "number",
            label: "Y",
            name: "y",
            defaultValue: 1,
            step: 0.1,
            supportsSpline: true,
            min: -10,
            max: 10,
            softMin: -4,
            softMax: 4,
          },
        ],
      },
      {
        id: "rotation",
        title: "ROTATION (Degrees)",
        columns: 1,
        controls: [
          {
            type: "number",
            label: "Angle",
            name: "angle",
            defaultValue: 0,
            supportsSpline: true,
            min: -360,
            max: 360,
            softMin: -360,
            softMax: 360,
            valueTransform: DEGREES_TO_RADIANS,
          },
        ],
      },
      {
        id: "skew",
        title: "SKEW (Degrees)",
        columns: "1fr 32px 1fr",
        controls: [
          {
            type: "number",
            label: "X",
            name: "x",
            defaultValue: 0,
            supportsSpline: true,
            // A shear's tangent diverges at 90°; past ±85° the clip is a sliver.
            min: -85,
            max: 85,
            softMin: -60,
            softMax: 60,
            valueTransform: DEGREES_TO_RADIANS,
          },
          { type: "spacer", label: "", name: "_", defaultValue: null },
          {
            type: "number",
            label: "Y",
            name: "y",
            defaultValue: 0,
            supportsSpline: true,
            min: -85,
            max: 85,
            softMin: -60,
            softMax: 60,
            valueTransform: DEGREES_TO_RADIANS,
          },
        ],
      },
    ],
  },
};
