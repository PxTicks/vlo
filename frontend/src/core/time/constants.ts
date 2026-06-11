/**
 * Core time/scale constants. Pure primitives — no feature imports.
 *
 * `TICKS_PER_SECOND` (96000) is the canonical timeline time base, divisible by
 * every supported fps so tick<->frame math is exact in integers.
 * `PIXELS_PER_SECOND` is the on-screen base scale (zoom = 1). These anchor all
 * tick<->frame (frameGrid) and tick<->pixel (pixelGrid) conversions.
 */
export const TICKS_PER_SECOND = 96000;
export const PIXELS_PER_SECOND = 100;
export const TICKS_PER_PIXEL = TICKS_PER_SECOND / PIXELS_PER_SECOND;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 20;

/** Generic numeric epsilon for tick/time comparisons. */
export const EPSILON = 0.001;
