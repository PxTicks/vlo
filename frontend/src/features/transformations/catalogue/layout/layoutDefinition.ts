/**
 * layoutDefinition.ts
 *
 * Unified layout transformation definition that aggregates position, scale, and rotation.
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
export const getBaseLayout = (containerSize: Size, contentSize: Size) => {
  const template = TemplateRegistry["contain"];
  const defaults = template({ container: containerSize, content: contentSize });

  // Return only layout-related defaults
  return {
    scaleX: 1,
    scaleY: 1,
    x: containerSize.width / 2,
    y: containerSize.height / 2,
    rotation: 0,
    ...defaults,
  };
};

export const layoutApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
) => {
  target.anchor?.set(0.5);
  target.position.set(state.x, state.y);
  target.scale.set(state.scaleX, state.scaleY);
  target.rotation = state.rotation;
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
  }
};

// =============================================================================
// DEFINITION
// =============================================================================

/**
 * The unified layout transformation definition.
 *
 * This definition handles position, scale, and rotation as a single logical group.
 * The UI renders separate control groups for each sub-transformation.
 */
export const layoutDefinition: TransformationDefinition = {
  type: "layout",
  label: "Layout",
  compatibleClips: "visual",
  handledTypes: ["position", "scale", "rotation"],
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
            min: 0,
            max: 10,
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
            min: 0,
            max: 10,
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
            valueTransform: {
              toModel: (val: unknown) => ((val as number) * Math.PI) / 180,
              toView: (val: unknown) => ((val as number) * 180) / Math.PI,
            },
          },
        ],
      },
    ],
  },
};
