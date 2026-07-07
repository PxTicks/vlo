import type { Point2D } from "../transformations/utils/catmullRomUtils";

export type { Point2D };

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CentroidTrackingSample {
  /** Time in the caller's domain; only ordering and relative spacing matter. */
  time: number;
  /** Current target position in the same coordinate space as the centroid. */
  position: Point2D;
  /** Observed centroid in the same coordinate space as position. */
  centroid: Point2D;
}
