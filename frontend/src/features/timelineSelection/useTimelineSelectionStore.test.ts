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
      selectionMessage: null,
      selectionIncludeModeEnabled: false,
      selectionIncludedTrackIds: [],
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
    expect(result.current.selectionMessage).toBeNull();
    expect(result.current.selectionIncludeModeEnabled).toBe(false);
    expect(result.current.selectionIncludedTrackIds).toEqual([]);
    expect(result.current.selectionFpsOverride).toBeNull();
    expect(result.current.selectionFrameStep).toBe(1);
    expect(result.current.selectionRecommendedFps).toBeNull();
    expect(result.current.selectionRecommendedFrameStep).toBeNull();
    expect(result.current.selectionRecommendedMaxTicks).toBeNull();
  });

  it("enters and updates selection mode", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        message: "Focus on the foreground pass",
        includeTracks: true,
        includedTrackIds: ["track-1", "track-2", "track-1"],
      });
      result.current.updateSelectionStart(2_000);
      result.current.updateSelectionEnd(8_000);
    });

    expect(result.current.selectionMode).toBe(true);
    expect(result.current.selectionStartTick).toBe(2_000);
    expect(result.current.selectionEndTick).toBe(8_000);
    expect(result.current.selectionMessage).toBe("Focus on the foreground pass");
    expect(result.current.selectionIncludeModeEnabled).toBe(true);
    expect(result.current.selectionIncludedTrackIds).toEqual([
      "track-1",
      "track-2",
    ]);
  });

  it("resets mode and recommendations on exit", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        message: "Use these tracks",
        includeTracks: true,
        includedTrackIds: ["track-1"],
      });
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
    expect(result.current.selectionMessage).toBeNull();
    expect(result.current.selectionIncludeModeEnabled).toBe(false);
    expect(result.current.selectionIncludedTrackIds).toEqual([]);
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

  it("toggles included tracks without losing order", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.toggleSelectionIncludedTrack("track-b");
      result.current.toggleSelectionIncludedTrack("track-a");
      result.current.toggleSelectionIncludedTrack("track-b");
    });

    expect(result.current.selectionIncludedTrackIds).toEqual(["track-a"]);
  });

  it("does not enable include mode unless requested", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        includedTrackIds: ["track-1"],
      });
    });

    expect(result.current.selectionIncludeModeEnabled).toBe(false);
    expect(result.current.selectionIncludedTrackIds).toEqual([]);
  });
});
