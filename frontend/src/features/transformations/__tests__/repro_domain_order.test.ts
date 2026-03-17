import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransformationController } from "../hooks/useTransformationController";
import { useTimelineStore, TICKS_PER_SECOND } from "../../timeline";

// Mock Layout Config to ensure we have valid groups
vi.mock("../catalogue/layout/layoutConfig", () => ({
  layoutConfig: {
    groups: [
      {
        id: "position",
        controls: [
          { name: "x", type: "number", defaultValue: 0 },
          { name: "y", type: "number", defaultValue: 0 },
        ],
      },
      {
        id: "speed",
        controls: [{ name: "factor", type: "number", defaultValue: 1 }],
      },
    ],
  },
}));

// Mock Filter Registry
vi.mock("../catalogue/registry/FilterRegistry", () => ({
  FilterRegistry: {},
}));

describe("Transformation Domain Ordering", () => {
  const clipId = "clip-1";

  beforeEach(() => {
    useTimelineStore.setState({
      clips: [
        {
          id: clipId,
          trackId: "track-1",
          start: 0,
          timelineDuration: 10 * TICKS_PER_SECOND,
          offset: 0,
          type: "video",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Test Clip",
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 10 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
        },
      ],
      selectedClipIds: [clipId],
    });
  });

  it("should place Layout (Position) BEFORE Dynamic (Speed) even if Speed is added first", () => {
    const { result } = renderHook(() => useTransformationController());

    // 1. Add Speed Transform
    act(() => {
      result.current.handleAddTransform("speed");
    });

    const transformsAfterSpeed =
      useTimelineStore.getState().clips[0].transformations;
    expect(transformsAfterSpeed).toHaveLength(1);
    expect(transformsAfterSpeed[0].type).toBe("speed");

    // 2. Add Position Transform (via handleCommit, mimicking UI interaction with Layout panel)
    act(() => {
      result.current.handleCommit("position", "x", 100);
    });

    const finalTransforms =
      useTimelineStore.getState().clips[0].transformations;
    expect(finalTransforms).toHaveLength(2);

    // CRITICAL: Position must be BEFORE Speed
    // Index 0: Position
    // Index 1: Speed
    expect(finalTransforms[0].type).toBe("position");
    expect(finalTransforms[1].type).toBe("speed");
  });

  it("should append new Dynamic transforms AFTER existing Layout transforms", () => {
    const { result } = renderHook(() => useTransformationController());

    // 1. Add Position
    act(() => {
      result.current.handleCommit("position", "x", 50);
    });

    // 2. Add Speed
    act(() => {
      result.current.handleAddTransform("speed");
    });

    const finalTransforms =
      useTimelineStore.getState().clips[0].transformations;
    expect(finalTransforms).toHaveLength(2);
    expect(finalTransforms[0].type).toBe("position");
    expect(finalTransforms[1].type).toBe("speed");
  });

  it("should place newly added Layout transforms before multiple existing Dynamic transforms", () => {
    const { result } = renderHook(() => useTransformationController());

    // 1. Add Speed
    act(() => {
      result.current.handleAddTransform("speed");
    });
    // 2. Add another Dynamic (simulating a filter, using speed as proxy for dynamic in this mock)
    act(() => {
      // Just adding another speed for simplicity, or we could mock filter
      result.current.handleAddTransform("speed");
    });

    const current = useTimelineStore.getState().clips[0].transformations;
    expect(current).toHaveLength(2);
    expect(current[0].type).toBe("speed");
    expect(current[1].type).toBe("speed");

    // 3. Add Scale (Layout)
    act(() => {
      // layoutConfig mock doesn't have scale, but code shouldn't crash, it just won't find defaults.
      // Wait, handleCommit checks layoutConfig. We should add Scale to mock or use Position.
      // Let's use Position again, ensuring it jumps the queue.
      result.current.handleCommit("position", "y", 200);
    });

    const finalTransforms =
      useTimelineStore.getState().clips[0].transformations;
    expect(finalTransforms).toHaveLength(3);

    // Position should be FIRST
    expect(finalTransforms[0].type).toBe("position");
    expect(finalTransforms[1].type).toBe("speed");
    expect(finalTransforms[2].type).toBe("speed");
  });
});
