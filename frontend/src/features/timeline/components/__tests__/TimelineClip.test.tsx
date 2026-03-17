import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimelineClipItem } from "../TimelineClip";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../../hooks/useInteractionStore";
import type {
  TimelineClip as TimelineClipType,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { TRACK_HEADER_WIDTH } from "../../constants";

// --- MOCKS ---

// Mock dnd-kit hooks to prevent errors during render
vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
    transform: null,
  }),
}));

// Mock the canvas component to avoid canvas context errors
vi.mock("../ThumbnailCanvas", () => ({
  ThumbnailCanvas: () => <div data-testid="thumbnail-canvas" />,
}));

// Mock View Store for zoom/pixel conversion
vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: {
    getState: () => ({
      ticksToPx: (t: number) => t, // 1:1 mapping for simplicity
      zoomScale: 1,
    }),
    subscribe: vi.fn(),
  },
}));

describe("TimelineClip Visual Geometry", () => {
  const mockClip: TimelineClipType = {
    id: "clip_1",
    trackId: "track_1",
    start: 100,
    timelineDuration: 200,
    type: "video",
    name: "Test Clip",
    transformations: [],
    offset: 0,
    sourceDuration: 200,
    transformedDuration: 200,
    transformedOffset: 0,
    croppedSourceDuration: 200,
  };

  beforeEach(() => {
    // Reset stores
    useTimelineStore.setState({
      selectedClipIds: [],
      tracks: [{ id: "track_1", label: "Track 1" } as unknown as TimelineTrack],
    });
    useInteractionStore.setState({ activeId: null, operation: null });
  });

  it("REGRESSION: Renders with strict 0px offset when in Overlay mode", () => {
    // This guards against the 'Ghost Offset' bug where the header width
    // was accidentally applied to the drag overlay.

    render(<TimelineClipItem clip={mockClip} isOverlay={true} />);

    const clipElement = screen.getByTestId("timeline-clip");

    // 1. Must NOT rely on calculation
    expect(clipElement.style.left).toBe("0px");

    // 2. Must NOT contain the header width variable or constant
    expect(clipElement.style.left).not.toContain(`${TRACK_HEADER_WIDTH}px`);
  });

  it("REGRESSION: Renders with robust calc() formula in Standard mode", () => {
    // This guards against the 'Resize Flush Left' bug.
    // We ensure the clip is anchored to the Header Width and Zoom.

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    const clipElement = screen.getByTestId("timeline-clip");

    // The raw inline style should contain our robust formula
    const inlineLeft = clipElement.style.left;

    // 1. Must anchor to Header Width
    expect(inlineLeft).toContain(`${TRACK_HEADER_WIDTH}px`);

    // 2. Must scale with Zoom
    expect(inlineLeft).toContain("var(--timeline-zoom, 1)");

    // 3. Must include the delta variable for hardware-accelerated resizing
    expect(inlineLeft).toContain("var(--drag-delta-x, 0px)");
  });

  it("applies resize deltas via CSS variables", () => {
    // Simulate a resize operation active on this clip
    useInteractionStore.setState({
      activeId: `resize_left_${mockClip.id}`,
      operation: "resize_left",
      currentDeltaX: 50,
      constraints: { minPx: -100, maxPx: 100 },
    });

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);
    const clipElement = screen.getByTestId("timeline-clip");

    // We can check if the style property was set on the element
    // Note: In JSDOM, style properties set via JS are reflected in the style object
    expect(clipElement.style.getPropertyValue("--drag-delta-x")).toBe("50px");
    expect(clipElement.style.getPropertyValue("--drag-delta-w")).toBe("-50px");
  });
});
