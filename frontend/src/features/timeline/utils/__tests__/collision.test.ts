import { describe, it, expect } from "vitest";
import {
  getCollisionType,
  resolveCollision,
  CollisionType,
  hasAnyCollision,
  getResizeConstraints,
} from "../collision";
import type { TimelineClip } from "../../../../types/TimelineTypes";

describe("Collision Logic", () => {
  describe("getCollisionType", () => {
    it("detects no collision", () => {
      // Subject: 0-10, Obstacle: 20-30
      expect(getCollisionType(0, 10, 20, 30)).toBe(CollisionType.None);
      // Subject: 40-50, Obstacle: 20-30
      expect(getCollisionType(40, 50, 20, 30)).toBe(CollisionType.None);
    });

    it("detects inside collision", () => {
      // Subject: 22-28, Obstacle: 20-30
      expect(getCollisionType(22, 28, 20, 30)).toBe(CollisionType.Inside);
    });

    it("detects enclosing collision", () => {
      // Subject: 10-40, Obstacle: 20-30
      expect(getCollisionType(10, 40, 20, 30)).toBe(CollisionType.Enclosing);
    });

    it("detects obstacle on left (partial overlap)", () => {
      // Subject: 25-35, Obstacle: 20-30
      // Subject starts (25) after Obstacle starts (20)
      expect(getCollisionType(25, 35, 20, 30)).toBe(
        CollisionType.ObstacleOnLeft,
      );
    });

    it("detects obstacle on right (partial overlap)", () => {
      // Subject: 15-25, Obstacle: 20-30
      // Subject starts (15) before Obstacle starts (20)
      expect(getCollisionType(15, 25, 20, 30)).toBe(
        CollisionType.ObstacleOnRight,
      );
    });
  });

  describe("resolveCollision", () => {
    const mockClips: TimelineClip[] = [
      {
        id: "clip_1",
        trackId: "track_1",
        start: 100,
        timelineDuration: 100, // Ends at 200
        sourceDuration: 100,
        transformedDuration: 100,
        transformedOffset: 0,
      } as TimelineClip,
      {
        id: "clip_2",
        trackId: "track_1",
        start: 300,
        timelineDuration: 100, // Ends at 400
        sourceDuration: 100,
        transformedDuration: 100,
        transformedOffset: 0,
      } as TimelineClip,
    ];

    it("allows movement in free space", () => {
      // Move to 220 (End 270), Duration 50. Space is 200-300.
      const result = resolveCollision(
        "moving_clip",
        220,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBe(220);
    });

    it("snaps to the end of the left obstacle", () => {
      // Move to 90 (End 140), Duration 50. Hits clip_1 (100-200).
      // Actually, if we are at 90, we hit the HEAD of clip_1.
      // 90-140 vs 100-200.
      // Subject starts (90) < Obs starts (100) -> ObstacleOnRight.
      // Should snap to ObsStart (100) - Duration (50) = 50.
      const result = resolveCollision(
        "moving_clip",
        90,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBe(50);
    });

    it("snaps to the start of the right obstacle", () => {
      // Move to 280 (End 330), Duration 50. Hits clip_2 (300-400).
      // Subject starts (280) < Obs starts (300) -> ObstacleOnRight.
      // Should snap to ObsStart (300) - Duration (50) = 250.
      const result = resolveCollision(
        "moving_clip",
        280,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBe(250);
    });

    it("snaps to the end of the left obstacle (tail hit)", () => {
      // Move to 180 (End 230), Duration 50. Hits clip_1 (100-200).
      // Subject starts (180) > Obs starts (100) -> ObstacleOnLeft.
      // Should snap to ObsEnd (200).
      const result = resolveCollision(
        "moving_clip",
        180,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBe(200);
    });

    it("returns null for invalid hard collisions (Inside)", () => {
      // Move to 120 (End 170), Duration 50. Inside clip_1 (100-200).
      const result = resolveCollision(
        "moving_clip",
        120,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBeNull();
    });

    it("respects the left wall (time 0)", () => {
      // Move to -50.
      const result = resolveCollision(
        "moving_clip",
        -50,
        50,
        "track_1",
        mockClips,
      );
      expect(result).toBe(0);
    });

    it("ignores mask clips as obstacles", () => {
      const result = resolveCollision("moving_clip", 120, 50, "track_1", [
        {
          id: "mask_1",
          type: "mask",
          trackId: "track_1",
          start: 100,
          timelineDuration: 100,
          sourceDuration: 100,
          transformedDuration: 100,
          transformedOffset: 0,
        } as TimelineClip,
      ]);
      expect(result).toBe(120);
    });
  });

  describe("hasAnyCollision", () => {
    it("ignores mask clips as collision obstacles", () => {
      const result = hasAnyCollision(120, 50, "track_1", ["moving_clip"], [
        {
          id: "mask_1",
          type: "mask",
          trackId: "track_1",
          start: 100,
          timelineDuration: 100,
          sourceDuration: 100,
          transformedDuration: 100,
          transformedOffset: 0,
        } as TimelineClip,
      ]);
      expect(result).toBe(false);
    });
  });

  describe("getResizeConstraints", () => {
    it("ignores mask clips when finding neighboring clips", () => {
      const result = getResizeConstraints(
        {
          id: "clip_1",
          type: "video",
          trackId: "track_1",
          start: 100,
          timelineDuration: 100,
          offset: 0,
          sourceDuration: 500,
          transformedDuration: 500,
          transformedOffset: 0,
          croppedSourceDuration: 500,
        } as TimelineClip,
        [
          {
            id: "mask_1",
            type: "mask",
            trackId: "track_1",
            start: 0,
            timelineDuration: 100,
            offset: 0,
            sourceDuration: 100,
            transformedDuration: 100,
            transformedOffset: 0,
            croppedSourceDuration: 100,
          } as TimelineClip,
        ],
        "left",
      );

      expect(result.min).toBe(100);
    });
  });
});
