// src/components/timeline/utils/collision.ts

import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../constants";

// --- TYPES & INTERFACES ---

export const CollisionType = {
  None: "NONE",
  Inside: "INSIDE",
  Enclosing: "ENCLOSING",
  ObstacleOnLeft: "OBSTACLE_ON_LEFT",
  ObstacleOnRight: "OBSTACLE_ON_RIGHT",
} as const;

// Create a type derived from the values above
export type CollisionType = (typeof CollisionType)[keyof typeof CollisionType];

// Unified interface for Clips and Walls to avoid @ts-ignore
interface CollisionEntity {
  id: string;
  start: number;
  end: number;
  isWall?: boolean;
}

function isCollisionObstacle(clip: TimelineClip): boolean {
  return clip.type !== "mask";
}

// --- HELPER FUNCTIONS ---

export const round = (num: number) => Math.round(num);

export const getMinimumClipDurationTicks = (projectFps: number): number =>
  TICKS_PER_SECOND / Math.max(1, projectFps);

/**
 * Pure function: Determines the geometric relationship between two intervals.
 * Returns the relationship relative to the 'subject' (the moving clip).
 */
export const getCollisionType = (
  subjectStart: number,
  subjectEnd: number,
  obsStart: number,
  obsEnd: number,
): CollisionType => {
  // 1. No Overlap
  if (subjectEnd <= obsStart || subjectStart >= obsEnd) {
    return CollisionType.None;
  }

  // 2. Total Overlaps (Invalid states)
  // Subject is inside the obstacle
  if (subjectStart >= obsStart && subjectEnd <= obsEnd) {
    return CollisionType.Inside;
  }
  // Subject engulfs the obstacle
  if (subjectStart <= obsStart && subjectEnd >= obsEnd) {
    return CollisionType.Enclosing;
  }

  // 3. Partial Overlaps
  // If the subject starts after the obstacle starts, the obstacle is on the Left.
  if (subjectStart > obsStart) {
    return CollisionType.ObstacleOnLeft;
  }

  // Otherwise, the obstacle is on the Right.
  return CollisionType.ObstacleOnRight;
};

/**
 * Helper to check if a specific placement is valid against a list of entities.
 * Used to verify if a "snapped" position causes a secondary collision.
 */
const isPositionValid = (
  start: number,
  end: number,
  ignoreId: string,
  entities: CollisionEntity[],
): boolean => {
  return !entities.some((entity) => {
    if (entity.id === ignoreId) return false;
    const type = getCollisionType(start, end, entity.start, entity.end);
    return type !== CollisionType.None;
  });
};

// --- MAIN RESOLUTION LOGIC FOR A SINGLE CLIP ---

export const resolveCollision = (
  movingClipId: string,
  newStart: number,
  timelineDuration: number,
  trackId: string,
  allClips: TimelineClip[],
): number | null => {
  const startTick = round(newStart);
  const durationTick = round(timelineDuration);
  const endTick = startTick + durationTick;

  // 1. Prepare Entities (Clips + Wall)
  const otherClips: CollisionEntity[] = allClips
    .filter(
      (c) => c.trackId === trackId && c.id !== movingClipId && isCollisionObstacle(c),
    )
    .map((c) => ({
      id: c.id,
      start: c.start,
      end: c.start + c.timelineDuration,
    }));

  const leftWall: CollisionEntity = {
    id: "LEFT_WALL",
    start: Number.MIN_SAFE_INTEGER, // Effectively infinite to the left
    end: 0,
    isWall: true,
  };

  const obstacles = [...otherClips, leftWall];

  // 2. Check for collisions at the requested position
  for (const obstacle of obstacles) {
    const type = getCollisionType(
      startTick,
      endTick,
      obstacle.start,
      obstacle.end,
    );

    if (type === CollisionType.None) continue;

    // 3. Handle Invalid Hard Collisions
    // If dragging directly *into* or *around* another clip, we block movement.
    if (
      (type === CollisionType.Inside || type === CollisionType.Enclosing) &&
      !obstacle.isWall
    ) {
      return null;
    }

    // 4. Resolve Partial Collisions (Snap)
    let snapStart = startTick;

    if (type === CollisionType.ObstacleOnLeft) {
      // We hit the tail of an obstacle on our left -> Snap to its end
      snapStart = obstacle.end;
    } else if (type === CollisionType.ObstacleOnRight) {
      // We hit the head of an obstacle on our right -> Snap to its start (minus our duration)
      snapStart = obstacle.start - durationTick;
    }

    // Wall Override: If we hit the wall, we explicitly snap to 0.
    if (obstacle.isWall) {
      snapStart = 0;
    }

    // 5. Verify the Snapped Position
    // Does snapping to this new position cause a collision with a *third* object?
    const isValid = isPositionValid(
      snapStart,
      snapStart + durationTick,
      obstacle.id, // Don't check against the obstacle we just snapped to
      obstacles,
    );

    if (!isValid) return null;

    return snapStart;
  }

  // No collisions found, return original rounded position
  return startTick;
};

// --- STRICTER DETECTION LOGIC FOR MULTIPLE CLIPS ---

export const hasAnyCollision = (
  start: number,
  timelineDuration: number,
  trackId: string,
  ignoreIds: string[],
  allClips: TimelineClip[],
): boolean => {
  const startTick = Math.round(start);
  const endTick = startTick + Math.round(timelineDuration);

  // 1. Check bounds (cannot be negative)
  if (startTick < 0) return true;

  // 2. Filter obstacles: Same track, not in the ignore list
  const obstacles = allClips.filter(
    (c) =>
      c.trackId === trackId &&
      !ignoreIds.includes(c.id) &&
      isCollisionObstacle(c),
  );

  // 3. Check for overlaps
  for (const obstacle of obstacles) {
    const obsEnd = obstacle.start + obstacle.timelineDuration;
    const type = getCollisionType(startTick, endTick, obstacle.start, obsEnd);

    // Any overlap type (Inside, Enclosing, Partial) is a failure
    if (type !== CollisionType.None) {
      return true;
    }
  }

  return false;
};

// --- RESIZE CONSTRAINTS ---

export const getResizeConstraints = (
  clip: TimelineClip,
  allClips: TimelineClip[],
  direction: "left" | "right",
  minDuration: number = 1,
) => {
  const trackClips = allClips.filter(
    (c) => c.trackId === clip.trackId && c.id !== clip.id && isCollisionObstacle(c),
  );

  if (direction === "left") {
    let minStart = 0;

    // Find the closest neighbor on the left
    const leftNeighbor = trackClips
      .filter((c) => c.start + c.timelineDuration <= clip.start)
      .sort(
        (a, b) => b.start + b.timelineDuration - (a.start + a.timelineDuration),
      )[0];

    if (leftNeighbor) {
      minStart = Math.max(
        minStart,
        leftNeighbor.start + leftNeighbor.timelineDuration,
      );
    }

    // Constraint: Can't resize past the beginning of the source media
    // OLD: const sourceStartLimit = clip.start - clip.offset;
    const sourceStartLimit = clip.start - clip.transformedOffset;
    minStart = Math.max(minStart, sourceStartLimit);

    // Constraint: Can't resize to make duration less than minDuration
    const maxStart = clip.start + clip.timelineDuration - minDuration;

    return { min: minStart, max: maxStart };
  } else {
    let maxEnd = Infinity;

    // Find the closest neighbor on the right
    const rightNeighbor = trackClips
      .filter((c) => c.start >= clip.start + clip.timelineDuration)
      .sort((a, b) => a.start - b.start)[0];

    if (rightNeighbor) {
      maxEnd = rightNeighbor.start;
    }

    // Constraint: Can't resize past the end of finite source media.
    // Images are intentionally unbounded and should be extendable arbitrarily.
    const isUnboundedSource =
      clip.type === "image" || clip.sourceDuration === null;
    if (!isUnboundedSource) {
      const sourceEndLimit =
        clip.transformedDuration + clip.start - clip.transformedOffset;
      maxEnd = Math.min(maxEnd, sourceEndLimit);
    }

    const minEnd = clip.start + minDuration;

    return { min: minEnd, max: maxEnd };
  }
};
