// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { useClipResize } from "../useClipResize";
import { useTimelineStore } from "../../../useTimelineStore";
import { useTimelineViewStore } from "../../useTimelineViewStore";
import { TICKS_PER_SECOND } from "../../../constants";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { useProjectStore } from "../../../../project";

// Mock Store
vi.mock("../../../useTimelineStore", () => ({
  useTimelineStore: {
    getState: vi.fn(),
  },
}));
vi.mock("../../useTimelineViewStore");
vi.mock("../../../../project", () => ({
  useProjectStore: {
    getState: vi.fn(),
  },
}));
// We don't mock collision or timeCalculation to test "real" logic interaction
// (assuming they are pure functions without side effects found in this test env)

describe("useClipResize Logic", () => {
  let mockClip: TimelineClip;
  let mockUpdateClipShape: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClip = {
      id: "clip-1",
      trackId: "track-1",
      start: 0,
      timelineDuration: 10 * TICKS_PER_SECOND, // 10s
      sourceDuration: 20 * TICKS_PER_SECOND, // 20s total source
      transformedDuration: 20 * TICKS_PER_SECOND, // Added (1x speed default)
      transformedOffset: 0, // Added
      offset: 0,
      croppedSourceDuration: 20 * TICKS_PER_SECOND, // Add croppedSourceDuration
      type: "video",
      name: "Test Clip",
      transformations: [],
    };

    mockUpdateClipShape = vi.fn();

    // Mock Store State
    mockUpdateClipShape = vi.fn();

    // Mock Store State
    vi.mocked(useTimelineStore.getState).mockReturnValue({
      clips: [mockClip],
      updateClipShape: mockUpdateClipShape,
    } as unknown as ReturnType<typeof useTimelineStore.getState>);

    // Mock View Store (pxToTicks)
    vi.mocked(useTimelineViewStore.getState).mockReturnValue({
      pxToTicks: (px: number) => px * 100, // 1px = 100 ticks
    } as unknown as ReturnType<typeof useTimelineViewStore.getState>);

    vi.mocked(useProjectStore.getState).mockReturnValue({
      config: { fps: 30 },
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  });

  it("should right-resize normally (Speed 1x)", () => {
    const { handleEnd } = useClipResize();

    // Drag 100px right (+10000 ticks)
    const event = { delta: { x: 100 } } as DragEndEvent;

    handleEnd(event, mockClip, "resize_right");

    expect(mockUpdateClipShape).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        timelineDuration: mockClip.timelineDuration + 10000,
      }),
    );
  });

  it("should clamp right-resize to source duration (Speed 1x)", () => {
    const { handleEnd } = useClipResize();

    // Try expand by 15s (Source has only 10s left)
    // 15 * 96000 = 1440000 ticks
    // 1px = 100 ticks -> 14400px
    const event = { delta: { x: 14400 } } as DragEndEvent;

    handleEnd(event, mockClip, "resize_right");

    // Should clamp to +10s (remaining source)
    // New Duration = 20s
    expect(mockUpdateClipShape).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        timelineDuration: 20 * TICKS_PER_SECOND,
      }),
    );
  });

  it("should right-resize with Speed 2x (Duration 5s, Content 10s)", () => {
    // Setup clip with Speed 2x
    // Duration = 5s (visual) -> Content = 10s
    mockClip.timelineDuration = 5 * TICKS_PER_SECOND;
    mockClip.transformations = [
      {
        id: "t1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2.0 },
      },
    ];

    const { handleEnd } = useClipResize();

    // Resize Right by +1s visual (96000 ticks) => +2s content
    // 96000 / 100 = 960px
    const event = { delta: { x: 960 } } as DragEndEvent;

    handleEnd(event, mockClip, "resize_right");

    expect(mockUpdateClipShape).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        timelineDuration: (5 + 1) * TICKS_PER_SECOND, // 6s visual
      }),
    );
  });

  it("should update offset/content correctly on Left Resize (Speed 2x)", () => {
    // Setup clip with Speed 2x
    mockClip.timelineDuration = 5 * TICKS_PER_SECOND;
    mockClip.transformations = [
      {
        id: "t1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2.0 },
      },
    ];

    const { handleEnd } = useClipResize();

    // Resize Left by +1s (Moving start forward 1s).
    // Visual delta = 96000.
    // Should skip 2s of content.
    // Offset should increase by 2s.
    // Duration should decrease by 1s.

    const event = { delta: { x: 960 } } as DragEndEvent; // +1s

    handleEnd(event, mockClip, "resize_left");

    expect(mockUpdateClipShape).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        start: mockClip.start + 96000,
        timelineDuration: mockClip.timelineDuration - 96000,
        offset: mockClip.offset + 2 * 96000,
      }),
    );
  });

  it("Regression Test: Restore cropped content after speed up (Step 4)", () => {
    // Scenario:
    // 1. Clip starts at 0, 15s long.
    // 2. Drag left edge to 5s. (Start=5, Duration=10, Offset=5).
    // 3. Apply x2 speed. (Start=5, Duration=5[visual], Offset=5).
    //    Correct State: transformedOffset should be scaled to 2.5s.
    // 4. Drag left edge out as far as possible (Targeting Offset=0).

    // Setup State corresponding to CORRECT "After Step 3":
    mockClip.sourceDuration = 15 * TICKS_PER_SECOND;
    mockClip.start = 5 * TICKS_PER_SECOND;
    mockClip.timelineDuration = 5 * TICKS_PER_SECOND;
    mockClip.offset = 5 * TICKS_PER_SECOND;

    // This is the key fix: transformedOffset must be scaled by speed (5s / 2 = 2.5s)
    mockClip.transformedOffset = 2.5 * TICKS_PER_SECOND;

    mockClip.transformations = [
      {
        id: "t1",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2.0 },
      },
    ];

    const { handleEnd } = useClipResize();

    // Action: Drag left edge back out "as far as it goes"
    // Max recover amount: limit is start - transformedOffset = 5 - 2.5 = 2.5s.
    // So we can drag left by -2.5s.

    // -2.5s = -240000 ticks.
    // -2400px.
    const event = { delta: { x: -2400 } } as DragEndEvent;

    handleEnd(event, mockClip, "resize_left");

    expect(mockUpdateClipShape).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        start: 2.5 * TICKS_PER_SECOND, // 5 - 2.5
        timelineDuration: 7.5 * TICKS_PER_SECOND, // 5 + 2.5
        offset: 0,
      }),
    );
  });
});
