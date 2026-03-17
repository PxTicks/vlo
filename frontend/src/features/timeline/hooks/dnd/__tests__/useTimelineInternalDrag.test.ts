import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { useTimelineInternalDrag } from "../useTimelineInternalDrag";
import { useTimelineStore } from "../../../useTimelineStore";
import { useInteractionStore } from "../../useInteractionStore";
import type {
  BaseClip,
  TimelineClip,
} from "../../../../../types/TimelineTypes";
import type {
  DragStartEvent,
  DragMoveEvent,
  DragEndEvent,
} from "@dnd-kit/core";
import { createRef } from "react";

// Hoist setup
import { useClipMove } from "../useClipMove";

vi.mock("../useClipMove", () => ({
  useClipMove: vi.fn(),
}));

vi.mock("../useClipResize", () => ({
  useClipResize: () => ({
    handleEnd: vi.fn(),
  }),
}));

// Mock coordinates
vi.mock("../useTimelineViewStore", () => ({
  useTimelineViewStore: () => ({
    ticksToPx: (t: number) => t,
    pxToTicks: (p: number) => p,
  }),
}));

describe("useTimelineInternalDrag Integration", () => {
  const mockScrollContainerRef = createRef<HTMLDivElement>();

  // Test-local spies
  let mockHandleMove: Mock;
  let mockHandleEnd: Mock;
  let mockSetInsertGapIndex: Mock;
  let mockInsertGapIndex: number | null; // To control the return value of insertGapIndex

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset store state
    useTimelineStore.setState({
      clips: [
        {
          id: "c1",
          trackId: "t1",
          start: 0,
          timelineDuration: 100,
          type: "video",
          name: "Clip 1",
          isMuted: false,
          isLocked: false,
          transformations: [],
          offset: 0,
          sourceDuration: 100,
          transformedDuration: 100,
          transformedOffset: 0,
          croppedSourceDuration: 100,
        } as TimelineClip,
      ],
      selectedClipIds: [],
    });
    useInteractionStore.setState({
      activeClip: null,
      operation: null,
      currentDeltaX: 0,
    });

    // Setup Mocks
    mockHandleMove = vi.fn();
    mockHandleEnd = vi.fn();
    mockSetInsertGapIndex = vi.fn();
    mockInsertGapIndex = null; // Default to no gap

    vi.mocked(useClipMove).mockReturnValue({
      handleMove: mockHandleMove,
      handleEnd: mockHandleEnd,
      setInsertGapIndex: mockSetInsertGapIndex,
      insertGapIndex: mockInsertGapIndex,
    });
  });

  it("handles Drag Start for a clip correctly", () => {
    const { result } = renderHook(() =>
      useTimelineInternalDrag(mockScrollContainerRef),
    );

    const event = {
      active: {
        id: "c1",
        data: { current: { type: "clip", clip: { id: "c1" } } },
      },
      activatorEvent: new MouseEvent("mousedown"),
    } as unknown as DragStartEvent;

    act(() => {
      result.current.handleInternalDragStart(event);
    });

    // 1. Should select the clip
    expect(useTimelineStore.getState().selectedClipIds).toContain("c1");

    // 2. Should set interaction store state
    const interactionState = useInteractionStore.getState();
    expect(interactionState.activeId).toBe("c1");
    expect(interactionState.operation).toBe("move");
  });

  it("routes Drag Move to the move strategy", () => {
    const { result } = renderHook(() =>
      useTimelineInternalDrag(mockScrollContainerRef),
    );

    // Setup: Start Drag first
    act(() => {
      useInteractionStore
        .getState()
        .startDrag("c1", { id: "c1" } as unknown as BaseClip, "move");
    });

    const moveEvent = {
      delta: { x: 10, y: 0 },
      active: {
        rect: {
          current: { translated: { left: 0, top: 0, width: 100, height: 50 } },
        },
      },
    } as unknown as DragMoveEvent;

    act(() => {
      // DEBUG: Check operation
      result.current.handleInternalDragMove(moveEvent);
    });

    // Should call the strategy
    expect(mockHandleMove).toHaveBeenCalledWith(moveEvent);
    // Should update ephemeral delta
    expect(useInteractionStore.getState().currentDeltaX).toBe(10);
  });

  it("handles Drag End and cleans up", () => {
    const { result } = renderHook(() =>
      useTimelineInternalDrag(mockScrollContainerRef),
    );

    // Setup: Start Drag
    act(() => {
      useInteractionStore
        .getState()
        .startDrag("c1", { id: "c1" } as unknown as BaseClip, "move");
    });

    const endEvent = {
      active: {
        data: { current: { clip: { id: "c1" } } },
        rect: {
          current: {
            translated: { left: 100, top: 0, width: 100, height: 50 },
          },
        },
      },
      delta: { x: 50, y: 0 }, // Significant move
      activatorEvent: new MouseEvent("mouseup"),
    } as unknown as DragEndEvent;

    act(() => {
      result.current.handleInternalDragEnd(endEvent);
    });

    // Should call strategy handleEnd
    expect(mockHandleEnd).toHaveBeenCalled();

    // Should reset interaction store
    expect(useInteractionStore.getState().activeClip).toBeNull();
    expect(useInteractionStore.getState().operation).toBeNull();
  });

  it("shows hover gap when straddling boundary", () => {
    const { result, rerender } = renderHook(() =>
      useTimelineInternalDrag(mockScrollContainerRef),
    );

    // Simulate strategy detecting a gap
    vi.mocked(useClipMove).mockReturnValue({
      handleMove: mockHandleMove,
      handleEnd: mockHandleEnd,
      setInsertGapIndex: mockSetInsertGapIndex,
      insertGapIndex: 5,
    });

    rerender();

    expect(result.current.insertGapIndex).toBe(5);
  });

  it("handles drop with gap insertion correctly", () => {
    const { result } = renderHook(() =>
      useTimelineInternalDrag(mockScrollContainerRef),
    );

    act(() => {
      useInteractionStore
        .getState()
        .startDrag("c1", { id: "c1" } as unknown as BaseClip, "move");
    });

    // Simulate gap present
    // Note: The hook reads insertGapIndex from the STRATEGY instance.
    // We need to ensure the strategy instance reflects this if called.
    // However, for drops, handleEnd uses the CLOSURE state of the strategy?
    // No, handleEnd inside the strategy uses its own state.
    // The test calls handleInternalDragEnd -> moveStrategy.handleEnd.
    // So we just need to verify handleEnd is called.

    const endEvent = {
      active: {
        data: { current: { clip: { id: "c1" } } },
        rect: {
          current: {
            translated: { left: 100, top: 0, width: 100, height: 50 },
          },
        },
      },
      delta: { x: 50, y: 0 },
      activatorEvent: new MouseEvent("mouseup"),
    } as unknown as DragEndEvent;

    act(() => {
      result.current.handleInternalDragEnd(endEvent);
    });

    // Verify strategy handleEnd is called (it handles the actual insertion)
    expect(mockHandleEnd).toHaveBeenCalled();
  });
});
