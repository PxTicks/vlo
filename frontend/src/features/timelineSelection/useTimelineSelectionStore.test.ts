// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTimelineSelectionStore } from "./useTimelineSelectionStore";

describe("useTimelineSelectionStore", () => {
  beforeEach(() => {
    useTimelineSelectionStore.setState({
      selectionMode: false,
      selectionStartTick: 0,
      selectionEndTick: 0,
      selectionFpsOverride: null,
      selectionFrameStep: 1,
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedMaxTicks: null,
    });
  });

  it("initializes with selection mode off", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    expect(result.current.selectionMode).toBe(false);
    expect(result.current.selectionStartTick).toBe(0);
    expect(result.current.selectionEndTick).toBe(0);
    expect(result.current.selectionFpsOverride).toBeNull();
    expect(result.current.selectionFrameStep).toBe(1);
    expect(result.current.selectionRecommendedFps).toBeNull();
    expect(result.current.selectionRecommendedFrameStep).toBeNull();
    expect(result.current.selectionRecommendedMaxTicks).toBeNull();
  });

  it("enters and updates selection mode", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000);
      result.current.updateSelectionStart(2_000);
      result.current.updateSelectionEnd(8_000);
    });

    expect(result.current.selectionMode).toBe(true);
    expect(result.current.selectionStartTick).toBe(2_000);
    expect(result.current.selectionEndTick).toBe(8_000);
  });

  it("resets mode and recommendations on exit", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000);
      result.current.setSelectionRecommendations({
        fps: 16,
        frameStep: 4,
        maxTicks: 12_345,
      });
      result.current.exitSelectionMode();
    });

    expect(result.current.selectionMode).toBe(false);
    expect(result.current.selectionStartTick).toBe(0);
    expect(result.current.selectionEndTick).toBe(0);
    expect(result.current.selectionRecommendedFps).toBeNull();
    expect(result.current.selectionRecommendedFrameStep).toBeNull();
    expect(result.current.selectionRecommendedMaxTicks).toBeNull();
  });

  it("validates fps override and frame step", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.setSelectionFpsOverride(24);
      result.current.setSelectionFrameStep(8);
    });

    expect(result.current.selectionFpsOverride).toBe(24);
    expect(result.current.selectionFrameStep).toBe(8);

    act(() => {
      result.current.setSelectionFpsOverride(null);
      result.current.setSelectionFrameStep(-10);
    });

    expect(result.current.selectionFpsOverride).toBeNull();
    expect(result.current.selectionFrameStep).toBe(1);
  });
});
