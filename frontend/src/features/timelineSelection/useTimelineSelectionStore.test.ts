// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTimelineSelectionStore } from "./useTimelineSelectionStore";

describe("useTimelineSelectionStore", () => {
  beforeEach(() => {
    useTimelineSelectionStore.setState({
      selectionMode: false,
      selectionStage: "range",
      selectionStartTick: 0,
      selectionEndTick: 0,
      selectionMessage: null,
      selectionIncludeModeEnabled: false,
      selectionAllowIncludeAll: false,
      selectionIncludedTrackIds: [],
      selectionFpsOverride: null,
      selectionResolutionOverride: null,
      selectionFrameStep: 1,
      selectionFrameOffset: 1,
      selectionRecommendedFps: null,
      selectionRecommendedFrameStep: null,
      selectionRecommendedMaxTicks: null,
    });
  });

  it("initializes with selection mode off", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    expect(result.current.selectionMode).toBe(false);
    expect(result.current.selectionStage).toBe("range");
    expect(result.current.selectionStartTick).toBe(0);
    expect(result.current.selectionEndTick).toBe(0);
    expect(result.current.selectionMessage).toBeNull();
    expect(result.current.selectionIncludeModeEnabled).toBe(false);
    expect(result.current.selectionAllowIncludeAll).toBe(false);
    expect(result.current.selectionIncludedTrackIds).toEqual([]);
    expect(result.current.selectionFpsOverride).toBeNull();
    expect(result.current.selectionFrameStep).toBe(1);
    expect(result.current.selectionRecommendedFps).toBeNull();
    expect(result.current.selectionRecommendedFrameStep).toBeNull();
    expect(result.current.selectionRecommendedMaxTicks).toBeNull();
    expect(result.current.selectionRecommendedResolution).toBeNull();
  });

  describe("render resolution", () => {
    it("stores an offered rung as the override", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.setSelectionResolutionOverride(720);
      });

      expect(result.current.selectionResolutionOverride).toBe(720);
    });

    // Anything off the ladder would be accepted here and then rejected by the
    // project config the selection falls back to.
    it.each([1234, 0, -720, null])(
      "clears the override for an unsupported value: %s",
      (value) => {
        const { result } = renderHook(() => useTimelineSelectionStore());

        act(() => {
          result.current.setSelectionResolutionOverride(1080);
          result.current.setSelectionResolutionOverride(value);
        });

        expect(result.current.selectionResolutionOverride).toBeNull();
      },
    );

    // A workflow's target is whatever its rules declare, so the recommendation
    // is deliberately not held to the ladder.
    it("accepts a non-rung recommendation", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.setSelectionRecommendations({ resolution: 832 });
      });

      expect(result.current.selectionRecommendedResolution).toBe(832);
    });

    it("clears an unusable recommendation", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.setSelectionRecommendations({ resolution: 832 });
        result.current.setSelectionRecommendations({ resolution: 0 });
      });

      expect(result.current.selectionRecommendedResolution).toBeNull();
    });
  });

  it("enters and updates selection mode", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        message: "Focus on the foreground pass",
        includeTracks: true,
        allowIncludeAll: true,
        includedTrackIds: ["track-1", "track-2", "track-1"],
      });
      result.current.updateSelectionStart(2_000);
      result.current.updateSelectionEnd(8_000);
    });

    expect(result.current.selectionMode).toBe(true);
    expect(result.current.selectionStage).toBe("range");
    expect(result.current.selectionStartTick).toBe(2_000);
    expect(result.current.selectionEndTick).toBe(8_000);
    expect(result.current.selectionMessage).toBe("Focus on the foreground pass");
    expect(result.current.selectionIncludeModeEnabled).toBe(true);
    expect(result.current.selectionAllowIncludeAll).toBe(true);
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
        resolution: 720,
        frameStep: 4,
        maxTicks: 12_345,
      });
      result.current.exitSelectionMode();
    });

    expect(result.current.selectionMode).toBe(false);
    expect(result.current.selectionStage).toBe("range");
    expect(result.current.selectionStartTick).toBe(0);
    expect(result.current.selectionEndTick).toBe(0);
    expect(result.current.selectionMessage).toBeNull();
    expect(result.current.selectionIncludeModeEnabled).toBe(false);
    expect(result.current.selectionAllowIncludeAll).toBe(false);
    expect(result.current.selectionIncludedTrackIds).toEqual([]);
    expect(result.current.selectionRecommendedFps).toBeNull();
    expect(result.current.selectionRecommendedFrameStep).toBeNull();
    expect(result.current.selectionRecommendedMaxTicks).toBeNull();
  });

  describe("frame grid", () => {
    it("adopts the grid the caller declares on entry", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.enterSelectionMode(0, 5_000, {
          frameStep: 17,
          frameOffset: 5,
        });
      });

      expect(result.current.selectionFrameStep).toBe(17);
      expect(result.current.selectionFrameOffset).toBe(5);
    });

    // The bug this guards: a MiniMax selection left 17/5 behind, and the next
    // plain extraction snapped its range to that workflow's grid.
    it("does not inherit the previous selection's grid", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.enterSelectionMode(0, 5_000, {
          frameStep: 17,
          frameOffset: 5,
        });
        result.current.exitSelectionMode();
      });

      expect(result.current.selectionFrameStep).toBe(1);
      expect(result.current.selectionFrameOffset).toBe(1);

      act(() => {
        result.current.enterSelectionMode(0, 5_000);
      });

      expect(result.current.selectionFrameStep).toBe(1);
      expect(result.current.selectionFrameOffset).toBe(1);
    });

    // Even without the exit that normally clears it — a hand-typed grid from
    // the selection overlay must not outlive its own selection either.
    it("resets a leftover grid on the next entry", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.setSelectionFrameStep(17);
        result.current.setSelectionFrameOffset(5);
        result.current.enterSelectionMode(0, 5_000);
      });

      expect(result.current.selectionFrameStep).toBe(1);
      expect(result.current.selectionFrameOffset).toBe(1);
    });
  });

  describe("render settings", () => {
    it("adopts the fps and resolution the caller declares on entry", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.enterSelectionMode(0, 5_000, {
          fpsOverride: 16,
          resolutionOverride: 720,
        });
      });

      expect(result.current.selectionFpsOverride).toBe(16);
      expect(result.current.selectionResolutionOverride).toBe(720);
    });

    // Off-ladder short edges are rejected on entry for the same reason the
    // setter rejects them: the project config would not honour them.
    it("ignores a resolution off the offered rungs", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.enterSelectionMode(0, 5_000, {
          resolutionOverride: 1234,
        });
      });

      expect(result.current.selectionResolutionOverride).toBeNull();
    });

    it("does not inherit the previous selection's fps or resolution", () => {
      const { result } = renderHook(() => useTimelineSelectionStore());

      act(() => {
        result.current.enterSelectionMode(0, 5_000, { fpsOverride: 16 });
        result.current.setSelectionResolutionOverride(720);
        result.current.exitSelectionMode();
      });

      expect(result.current.selectionFpsOverride).toBeNull();
      expect(result.current.selectionResolutionOverride).toBeNull();

      act(() => {
        result.current.setSelectionFpsOverride(16);
        result.current.setSelectionResolutionOverride(720);
        result.current.enterSelectionMode(0, 5_000);
      });

      expect(result.current.selectionFpsOverride).toBeNull();
      expect(result.current.selectionResolutionOverride).toBeNull();
    });
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

  it("includes every track only when the caller enables the shortcut", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        includeTracks: true,
        allowIncludeAll: true,
      });
      result.current.includeAllSelectionTracks([
        "track-a",
        "track-b",
        "track-a",
      ]);
    });

    expect(result.current.selectionIncludedTrackIds).toEqual([
      "track-a",
      "track-b",
    ]);

    act(() => {
      result.current.exitSelectionMode();
      result.current.enterSelectionMode(1_000, 5_000, {
        includeTracks: true,
      });
      result.current.includeAllSelectionTracks(["track-c"]);
    });

    expect(result.current.selectionIncludedTrackIds).toEqual([]);
  });

  it("advances into track selection only when include mode is enabled", () => {
    const { result } = renderHook(() => useTimelineSelectionStore());

    act(() => {
      result.current.enterSelectionMode(1_000, 5_000, {
        includeTracks: true,
      });
      result.current.enterTrackSelectionStage();
    });

    expect(result.current.selectionStage).toBe("tracks");

    act(() => {
      result.current.returnToRangeSelectionStage();
    });

    expect(result.current.selectionStage).toBe("range");

    act(() => {
      result.current.exitSelectionMode();
      result.current.enterSelectionMode(1_000, 5_000);
      result.current.enterTrackSelectionStage();
    });

    expect(result.current.selectionStage).toBe("range");
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
