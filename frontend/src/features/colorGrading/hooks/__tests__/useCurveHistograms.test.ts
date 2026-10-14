import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorGradeHistogramRuntime,
  type ColorGradeHistogramSnapshot,
} from "../../../../core/color";
import { livePreviewParamStore } from "../../../../core/liveParams/livePreviewParamStore";
import { useCurveHistograms } from "../useCurveHistograms";

function snapshot(seed: number): ColorGradeHistogramSnapshot {
  return {
    before: { seed } as unknown as ColorGradeHistogramSnapshot["before"],
    after: { seed: seed + 1 } as unknown as ColorGradeHistogramSnapshot["after"],
  };
}

describe("useCurveHistograms", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes while active, requests a render and returns published snapshots", () => {
    const requestRender = vi.spyOn(livePreviewParamStore, "requestRender");
    const { result, rerender, unmount } = renderHook(
      ({ id, active }) => useCurveHistograms(id, active),
      { initialProps: { id: "grade-a", active: true } },
    );

    expect(result.current).toBeNull();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(colorGradeHistogramRuntime.hasSubscription("grade-a")).toBe(true);

    const first = snapshot(1);
    act(() => colorGradeHistogramRuntime.publish("grade-a", first));
    expect(result.current).toBe(first);

    // A snapshot keyed to the previous transform never leaks into the next.
    rerender({ id: "grade-b", active: true });
    expect(result.current).toBeNull();
    expect(colorGradeHistogramRuntime.hasSubscription("grade-a")).toBe(false);

    rerender({ id: "grade-b", active: false });
    expect(result.current).toBeNull();
    expect(colorGradeHistogramRuntime.hasSubscription("grade-b")).toBe(false);
    unmount();
  });

  it("does not subscribe while inactive", () => {
    const requestRender = vi.spyOn(livePreviewParamStore, "requestRender");
    renderHook(() => useCurveHistograms("grade-hidden", false));
    expect(requestRender).not.toHaveBeenCalled();
    expect(colorGradeHistogramRuntime.hasSubscription("grade-hidden")).toBe(
      false,
    );
  });
});
