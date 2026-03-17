import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimelineContainer } from "../TimelineContainer";
import { useTimelineStore } from "../useTimelineStore";
import type { TimelineTrack, TimelineClip } from "../../../types/TimelineTypes";
import type { TimelineViewState } from "../hooks/useTimelineViewStore";

// --- 1. SETUP GLOBAL MOCKS ---
globalThis.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};

// --- 2. HOISTED VARIABLES ---
// We use vi.hoisted to define variables that can be accessed INSIDE vi.mock
const viewStoreMocks = vi.hoisted(() => {
  const setZoomScaleSpy = vi.fn();
  return {
    setZoomScale: setZoomScaleSpy,
    subscribe: vi.fn(() => vi.fn()), // returns unsubscribe
    getState: vi.fn(() => ({
      zoomScale: 1,
      currentTime: 0,
      ticksToPx: (t: number) => t,
      pxToTicks: (p: number) => p,
      setZoomScale: setZoomScaleSpy,
      setCurrentTime: vi.fn(),
      setScrollContainer: vi.fn(),
      scrollContainer: null,
    })),
  };
});

// --- 3. MOCK CHILD COMPONENTS ---
vi.mock("../components/TimelineRow", () => ({
  TimelineRow: ({ track }: { track: TimelineTrack }) => (
    <div data-testid="timeline-row">{track.label}</div>
  ),
}));

vi.mock("../components/TimelineToolbar", () => ({
  TimelineToolbar: () => <div data-testid="timeline-toolbar">Toolbar</div>,
}));

vi.mock("../components/HoverGapIndicator", () => ({
  HoverGapIndicator: () => <div data-testid="gap-indicator" />,
}));

// Mock both possible paths for safety
vi.mock("../TimelineRuler", () => ({
  TimelineRuler: () => <div data-testid="timeline-ruler">Ruler</div>,
}));
vi.mock("../components/TimelineRuler", () => ({
  TimelineRuler: () => <div data-testid="timeline-ruler">Ruler</div>,
}));

vi.mock("../TimelinePlayhead", () => ({
  TimelinePlayhead: () => <div data-testid="timeline-playhead">Playhead</div>,
}));
vi.mock("../components/TimelinePlayhead", () => ({
  TimelinePlayhead: () => <div data-testid="timeline-playhead">Playhead</div>,
}));

// --- 4. MOCK VIEW STORE ---
vi.mock("../hooks/useTimelineViewStore", () => {
  const useTimelineViewStoreMock = (
    selector: (state: TimelineViewState) => unknown,
  ) => {
    // 1. Get state from hoisted mock
    const state = viewStoreMocks.getState();
    // 2. Ensure the setter in the state points to the hoisted spy
    state.setZoomScale = viewStoreMocks.setZoomScale;

    return selector ? selector(state as TimelineViewState) : state;
  };

  useTimelineViewStoreMock.subscribe = viewStoreMocks.subscribe;
  useTimelineViewStoreMock.getState = viewStoreMocks.getState;
  useTimelineViewStoreMock.setState = vi.fn();

  return {
    useTimelineViewStore: useTimelineViewStoreMock,
  };
});

// --- 5. TESTS ---
describe("TimelineContainer", () => {
  const mockScrollRef = React.createRef<HTMLDivElement>();

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset Timeline Store
    useTimelineStore.setState({
      tracks: [
        {
          id: "t1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
        {
          id: "t2",
          label: "Track 2",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [],
      selectedClipIds: ["c1"],
    });

    // Reset View Store Mock Defaults
    viewStoreMocks.getState.mockReturnValue({
      zoomScale: 1,
      currentTime: 0,
      ticksToPx: (t: number) => t,
      pxToTicks: (p: number) => p,
      setZoomScale: viewStoreMocks.setZoomScale,
      setCurrentTime: vi.fn(),
      setScrollContainer: vi.fn(),
      scrollContainer: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the toolbar, ruler, and tracks", () => {
    render(
      <TimelineContainer
        scrollContainerRef={mockScrollRef}
        insertGapIndex={null}
      />,
    );

    expect(screen.getByTestId("timeline-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-ruler")).toBeInTheDocument();
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);
    expect(screen.getByText("Track 1")).toBeInTheDocument();
  });

  it("deselects clips when clicking the background", () => {
    render(
      <TimelineContainer
        scrollContainerRef={mockScrollRef}
        insertGapIndex={null}
      />,
    );

    expect(useTimelineStore.getState().selectedClipIds).toEqual(["c1"]);

    const toolbar = screen.getByTestId("timeline-toolbar");
    const scrollContainer = toolbar.nextElementSibling;
    if (!scrollContainer) throw new Error("Scroll container not found");

    fireEvent.click(scrollContainer);

    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("handles Delete key to remove selected clips", () => {
    render(
      <TimelineContainer
        scrollContainerRef={mockScrollRef}
        insertGapIndex={null}
      />,
    );

    fireEvent.keyDown(window, { key: "Delete" });

    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("handles copy + paste keyboard shortcuts for a single selected clip", () => {
    const sourceClip = {
      id: "c1",
      trackId: "t2",
      type: "video",
      name: "Clip 1",
      start: 100,
      timelineDuration: 50,
      offset: 0,
      croppedSourceDuration: 50,
      transformedOffset: 0,
      sourceDuration: 50,
      transformedDuration: 50,
      transformations: [],
    } as TimelineClip;

    useTimelineStore.setState({
      tracks: [
        {
          id: "t1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
        {
          id: "t2",
          label: "Track 2",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
        {
          id: "t3",
          label: "Track 3",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [sourceClip],
      selectedClipIds: [sourceClip.id],
      copiedClips: [],
    });

    render(
      <TimelineContainer
        scrollContainerRef={mockScrollRef}
        insertGapIndex={null}
      />,
    );

    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    const clips = useTimelineStore.getState().clips;
    expect(clips).toHaveLength(2);

    const pastedClip = clips.find((clip) => clip.id !== sourceClip.id);
    expect(pastedClip).toBeDefined();
    expect(pastedClip?.trackId).toBe("t1");
    expect(pastedClip?.start).toBe(sourceClip.start);
    expect(pastedClip?.timelineDuration).toBe(sourceClip.timelineDuration);
  });
});
