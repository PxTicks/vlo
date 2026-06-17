/**
 * Advanced blend-mode registration.
 *
 * PixiJS v8 ships standard blend modes (normal, add, multiply, screen, ...) as
 * built-in GPU blend equations, but the advanced/filter-based modes (overlay,
 * color-burn, color-dodge, hard-light, soft-light, difference, ...) must be
 * registered explicitly via the `pixi.js/advanced-blend-modes` side-effect
 * import. Without it, assigning one of those modes silently falls back to
 * "normal".
 *
 * Two further requirements for advanced modes on the WebGL renderer:
 *   1. The application must be initialised with `useBackBuffer: true` — advanced
 *      modes read from the back buffer; otherwise they silently fall back.
 *      (WebGPU enables the back buffer unconditionally.)
 *   2. `Filter.defaultOptions.resolution` must be "inherit" so the filter-based
 *      blends render at the render-target resolution; the default of `1` makes
 *      them clip/scale on high-DPI (retina) targets.
 *
 * Import this module once before creating any Pixi Application that may use
 * advanced blend modes. `enableAdvancedBlendModes()` is idempotent.
 */

import "pixi.js/advanced-blend-modes";
import { Filter } from "pixi.js";

let configured = false;

export function enableAdvancedBlendModes(): void {
  if (configured) return;
  configured = true;
  // Render filter-based blends at the render-target resolution rather than 1×,
  // so advanced modes are not clipped/scaled on high-DPI displays.
  Filter.defaultOptions.resolution = "inherit";
}
