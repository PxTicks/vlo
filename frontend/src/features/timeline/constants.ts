// features/Timeline/constants.ts
export const TRACK_HEIGHT = 60;
export const CLIP_HEIGHT = TRACK_HEIGHT - 10;
export const TRACK_HEADER_WIDTH = 80;
export const RULER_HEIGHT = 24;
export const EPSILON = 0.001;
export const LEFT_WALL_ID = "LEFT_WALL";
export const SPLIT_THRESHOLD_PX = TRACK_HEIGHT / 6;
export const SNAP_THRESHOLD_PX = 10;

export const TICKS_PER_SECOND = 96000;
export const PIXELS_PER_SECOND = 100;
export const TICKS_PER_PIXEL = TICKS_PER_SECOND / PIXELS_PER_SECOND;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 20;
