import { act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "../useTimelineStore";
import type { TimelineClip } from "../../../types/TimelineTypes";

// Mock crypto.randomUUID
Object.defineProperty(globalThis, "crypto", {
  value: {
    randomUUID: () => "mock-uuid-" + Math.random().toString(36).substring(2, 9),
  },
});

describe("useTimelineStore Split Clip", () => {
  const createMockClip = (
    id: string,
    start: number,
    duration: number,
    offset = 0,
  ): TimelineClip =>
    ({
      id,
      trackId: "track-1",
      type: "video",
      start,
      timelineDuration: duration,
      offset,
      croppedSourceDuration: duration,
      transformedOffset: 0,
      transformations: [],
      // volume removed as it might not be in the strict type or optional
      assetId: "asset-1",
      name: "Mock Clip",
      sourceDuration: duration,
      transformedDuration: duration,
    }) as TimelineClip;

  beforeEach(() => {
    useTimelineStore.setState({
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [],
      selectedClipIds: [],
    });
  });

  it("splits a clip correctly", () => {
    const clip = createMockClip("clip-1", 0, 1000); // 0 to 1000 ticks
    useTimelineStore.getState().addClip(clip);
    useTimelineStore.getState().selectClip(clip.id, false);

    const splitTime = 500;

    act(() => {
      useTimelineStore.getState().splitClip("clip-1", splitTime);
    });

    const clips = useTimelineStore.getState().clips;
    expect(clips).toHaveLength(2);

    // Check Left Clip (Original)
    const leftClip = clips.find((c) => c.id === "clip-1");
    expect(leftClip).toBeDefined();
    expect(leftClip?.start).toBe(0);
    expect(leftClip?.timelineDuration).toBe(500);
    expect(leftClip?.offset).toBe(0); // Offset shouldn't change for left side

    // Check Right Clip (New)
    const rightClip = clips.find((c) => c.id !== "clip-1");
    expect(rightClip).toBeDefined();
    expect(rightClip?.start).toBe(500);
    expect(rightClip?.timelineDuration).toBe(500);
    expect(rightClip?.offset).toBe(500); // Offset should increase by split amount

    // Check Selection
    const selectedIds = useTimelineStore.getState().selectedClipIds;
    expect(selectedIds).toHaveLength(1);
    expect(selectedIds[0]).toBe(rightClip?.id);
  });

  it("handles offset correctly when splitting", () => {
    // Clip starts at 1000, duration 1000.
    // Source offset is 2000.
    // So visual: 1000-2000. Source: 2000-3000.
    const clip = createMockClip("clip-2", 1000, 1000, 2000);
    useTimelineStore.getState().addClip(clip);

    const splitTime = 1500; // Halfway visually

    act(() => {
      useTimelineStore.getState().splitClip("clip-2", splitTime);
    });

    const clips = useTimelineStore.getState().clips;
    const leftClip = clips.find((c) => c.id === "clip-2")!;
    const rightClip = clips.find((c) => c.id !== "clip-2")!;

    // Left: 1000-1500 visually. Source: 2000-2500.
    expect(leftClip.start).toBe(1000);
    expect(leftClip.timelineDuration).toBe(500);
    expect(leftClip.offset).toBe(2000);

    // Right: 1500-2000 visually. Source: 2500-3000.
    expect(rightClip.start).toBe(1500);
    expect(rightClip.timelineDuration).toBe(500);
    // New Offset = Original Offset + (SplitTime - Start)
    // 2000 + (1500 - 1000) = 2500
    expect(rightClip.offset).toBe(2500);
  });

  it("does nothing if split time is outside bounds", () => {
    const clip = createMockClip("clip-3", 0, 1000);
    useTimelineStore.getState().addClip(clip);

    act(() => {
      useTimelineStore.getState().splitClip("clip-3", 2000); // Outside
    });

    expect(useTimelineStore.getState().clips).toHaveLength(1);
  });

  it("does nothing if split time is at edges", () => {
    const clip = createMockClip("clip-4", 0, 1000);
    useTimelineStore.getState().addClip(clip);

    act(() => {
      useTimelineStore.getState().splitClip("clip-4", 0);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(1);

    act(() => {
      useTimelineStore.getState().splitClip("clip-4", 1000);
    });
    expect(useTimelineStore.getState().clips).toHaveLength(1);
  });

  it("preserves other selections when splitting", () => {
    const clip1 = createMockClip("c1", 0, 1000);
    const clip2 = createMockClip("c2", 0, 1000); // Overlay or other track
    useTimelineStore.getState().addClip(clip1);
    useTimelineStore.getState().addClip(clip2);

    // Select both
    useTimelineStore.getState().selectClip("c1", true);
    useTimelineStore.getState().selectClip("c2", true);

    const splitTime = 500;

    act(() => {
      useTimelineStore.getState().splitClip("c1", splitTime);
    });

    const sel = useTimelineStore.getState().selectedClipIds;
    // c2 should still be selected. "c1" should be replaced by its right half ID.
    expect(sel).toContain("c2");
    expect(sel).toHaveLength(2);
    expect(sel).not.toContain("c1");
  });
});
