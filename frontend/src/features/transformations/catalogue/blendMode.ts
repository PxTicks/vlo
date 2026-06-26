/**
 * blendMode.ts
 *
 * Clip-level PixiJS blend mode. Modelled as an always-visible default
 * transform (like fitMode) with a single `select` control. Unlike fitMode,
 * this one carries runtime state: the handler writes `state.blendMode` and
 * `blendModeApplicator` pushes it onto the rendered target.
 *
 * The clip sprites all live as siblings (per-track containers) under one
 * shared, z-sorted parent, so a sprite's blend mode composites against the
 * accumulated render of everything beneath it — the expected behaviour.
 *
 * Standard modes (normal, add, multiply, screen) are GPU blend equations and
 * always work. Advanced modes (overlay, color-burn, ...) are filter-based and
 * require the advanced-blend-modes extension + a back buffer; see
 * `core/pixi/advancedBlendModes`. Without that setup PixiJS silently falls
 * back to "normal".
 */

import type { BLEND_MODES } from "pixi.js";
import type {
  ClipTransformTarget,
  TransformState,
  TransformHandler,
  TransformationDefinition,
} from "./types";
import type { ClipTransform } from "../../../types/TimelineTypes";

export const DEFAULT_BLEND_MODE = "normal";

/**
 * Blend-mode options exposed in the inspector. Order follows the familiar
 * Photoshop/Premiere grouping (darken family, lighten family, contrast,
 * comparative, component). Values are the exact PixiJS v8 blend-mode strings.
 * Advanced (filter-based) values are flagged so the registration check can
 * warn if the extension isn't loaded.
 */
export const BLEND_MODE_OPTIONS: ReadonlyArray<{
  label: string;
  value: BLEND_MODES;
  advanced?: boolean;
}> = [
  { label: "Normal", value: "normal" },
  { label: "Darken", value: "darken", advanced: true },
  { label: "Multiply", value: "multiply" },
  { label: "Color Burn", value: "color-burn", advanced: true },
  { label: "Linear Burn", value: "linear-burn", advanced: true },
  { label: "Lighten", value: "lighten", advanced: true },
  { label: "Screen", value: "screen" },
  { label: "Color Dodge", value: "color-dodge", advanced: true },
  { label: "Add (Linear Dodge)", value: "add" },
  { label: "Overlay", value: "overlay", advanced: true },
  { label: "Soft Light", value: "soft-light", advanced: true },
  { label: "Hard Light", value: "hard-light", advanced: true },
  { label: "Vivid Light", value: "vivid-light", advanced: true },
  { label: "Linear Light", value: "linear-light", advanced: true },
  { label: "Pin Light", value: "pin-light", advanced: true },
  { label: "Hard Mix", value: "hard-mix", advanced: true },
  { label: "Difference", value: "difference", advanced: true },
  { label: "Exclusion", value: "exclusion", advanced: true },
  { label: "Subtract", value: "subtract", advanced: true },
  { label: "Divide", value: "divide", advanced: true },
  { label: "Negation", value: "negation", advanced: true },
  { label: "Color", value: "color", advanced: true },
  { label: "Saturation", value: "saturation", advanced: true },
  { label: "Luminosity", value: "luminosity", advanced: true },
];

interface BlendModeParams {
  blendMode: string;
  [key: string]: unknown;
}

const blendModeHandler: TransformHandler<ClipTransform> = (
  state: TransformState,
  transform: ClipTransform,
) => {
  const params = transform.parameters as BlendModeParams;
  if (typeof params.blendMode === "string") {
    state.blendMode = params.blendMode;
  }
};

/**
 * Applicator: write the resolved blend mode onto the target every frame.
 * Always assigns (defaulting to "normal") so toggling the section off, or
 * switching back to Normal, restores standard compositing rather than leaving
 * a stale mode on the reused sprite.
 */
export const blendModeApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
) => {
  const mutable = target as { blendMode?: string };
  if ("blendMode" in target || mutable.blendMode !== undefined) {
    mutable.blendMode = state.blendMode ?? DEFAULT_BLEND_MODE;
  }
};

export const blendModeDefinition: TransformationDefinition = {
  type: "blendMode",
  label: "Blend Mode",
  compatibleClips: "visual",
  handler: blendModeHandler,
  uiConfig: {
    groups: [
      {
        id: "blendMode",
        title: "BLEND MODE",
        columns: 1,
        controls: [
          {
            type: "select",
            label: "Blend",
            name: "blendMode",
            defaultValue: DEFAULT_BLEND_MODE,
            options: BLEND_MODE_OPTIONS.map(({ label, value }) => ({
              label,
              value,
            })),
          },
        ],
      },
    ],
  },
};
