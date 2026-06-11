import {
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  TICKS_PER_PIXEL,
  MIN_ZOOM,
  MAX_ZOOM,
  EPSILON,
} from "../../core/time/constants";

// Timeline UI / layout constants (timeline-owned).
export const TRACK_HEIGHT = 60;
export const CLIP_HEIGHT = TRACK_HEIGHT - 10;
export const TRACK_HEADER_WIDTH = 80;
export const RULER_HEIGHT = 24;
export const LEFT_WALL_ID = "LEFT_WALL";
export const SPLIT_THRESHOLD_PX = TRACK_HEIGHT / 6;
export const SNAP_THRESHOLD_PX = 10;

/**
 * Initial length of a newly created adjustment clip. Adjustment-clip policy is
 * timeline-owned; derived from the core time base. Adjustment clips are freely
 * resizable from both edges, so this only seeds the first window.
 */
export const ADJUSTMENT_DEFAULT_DURATION_TICKS = 3 * TICKS_PER_SECOND;

// Time/scale primitives live in core/time; re-exported here for timeline-local
// use and barrel compatibility. Cross-feature consumers should import these
// from `core/time/constants` directly.
export {
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  TICKS_PER_PIXEL,
  MIN_ZOOM,
  MAX_ZOOM,
  EPSILON,
};
