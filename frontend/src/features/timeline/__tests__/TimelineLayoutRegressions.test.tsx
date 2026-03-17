import { render, screen } from "@testing-library/react";
import { TimelineContainer } from "../TimelineContainer";
import { useTimelineStore } from "../useTimelineStore";
import { vi } from "vitest";
import React from "react";
import { TRACK_HEADER_WIDTH, RULER_HEIGHT } from "../constants";
import type { TimelineClip } from "../../../types/TimelineTypes";

// Mock dependencies
vi.mock("../components/ThumbnailCanvas", () => ({
  ThumbnailCanvas: () => <div data-testid="thumbnail-canvas" />,
}));

// Fix: Mock useTimelineViewStore as a function behaving like a zustand hook
// AND having the static methods like getState attached to it.
vi.mock("../hooks/useTimelineViewStore", () => {
  const store = (selector: (state: unknown) => unknown) =>
    selector({
      zoomScale: 1,
      ticksToPx: (t: number) => t,
      setScrollContainer: vi.fn(),
      setZoomScale: vi.fn(),
    });
  store.getState = () => ({ zoomScale: 1 });
  store.subscribe = vi.fn(() => vi.fn());
  return { useTimelineViewStore: store };
});

// ResizeObserver mock
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Check for missing requestAnimationFrame
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}

describe("Timeline Layout Regressions", () => {
  const initialStoreState = useTimelineStore.getState();

  beforeEach(() => {
    useTimelineStore.setState(initialStoreState, true);
  });

  it("applies correct horizontal and vertical offsets to clips in the overlay layer", () => {
    // 1. Setup Store with 1 Track and 1 Clip starting at 0
    const trackId = "track_1";
    useTimelineStore.setState({
      tracks: [
        {
          id: trackId,
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "clip_1",
          trackId: trackId,
          start: 0,
          timelineDuration: 96000,
          offset: 0,
          type: "video",
          assetId: "asset_1",
          name: "Test Clip",
          transformations: [],
        } as unknown as TimelineClip,
      ],
      selectedClipIds: [],
    });

    // 2. Render Container
    const scrollContainerRef = React.createRef<HTMLDivElement>();
    render(
      <TimelineContainer
        scrollContainerRef={scrollContainerRef}
        insertGapIndex={null}
      />,
    );

    // 3. Find the Clip
    const clip = screen.getByTestId("timeline-clip");

    // 4. Assert Styles
    // Since we now use inline styles for layout props, retrieving them via `clip.style` is reliable in JSDOM.

    // Vertical Offset Check
    // Expected: RULER_HEIGHT (24) + Track Index (0) * TRACK_HEIGHT (60) + Padding (5) = 29px
    const topValue = parseInt(clip.style.top.replace("px", ""), 10);
    const expectedTop = RULER_HEIGHT + 5;
    expect(topValue).toBeGreaterThanOrEqual(expectedTop);

    // Horizontal Offset Check
    const leftStyle = clip.style.left;

    // Check that we are adding the header width
    expect(leftStyle).toContain(`${TRACK_HEADER_WIDTH}px`);

    // Ensure we are adding, not multiplying (regression check)
    expect(leftStyle).toMatch(
      new RegExp(`calc\\(\\s*${TRACK_HEADER_WIDTH}px\\s*\\+`),
    );
  });
});
