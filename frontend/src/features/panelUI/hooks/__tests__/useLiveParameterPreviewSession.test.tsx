import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { livePreviewParamStore } from "../../../../core/liveParams/livePreviewParamStore";
import { useLiveParameterPreviewSession } from "../useLiveParameterPreviewSession";

describe("useLiveParameterPreviewSession", () => {
  afterEach(() => livePreviewParamStore.clearAll());

  it("commits the exact merged preview before clearing overrides", () => {
    const onCommitMany = vi.fn(() => {
      expect(livePreviewParamStore.get("grade-1", "low")).toBe(0.25);
      expect(livePreviewParamStore.get("grade-1", "softness")).toBe(0);
    });
    const { result } = renderHook(() =>
      useLiveParameterPreviewSession({
        transformId: "grade-1",
        onCommitMany,
      }),
    );

    act(() => {
      result.current.begin();
      result.current.preview({ low: 0.2, softness: 0.1 });
      result.current.preview({ low: 0.25, softness: 0 });
      result.current.commit();
    });

    expect(onCommitMany).toHaveBeenCalledWith({ low: 0.25, softness: 0 });
    expect(livePreviewParamStore.get("grade-1", "low")).toBeUndefined();
    expect(livePreviewParamStore.get("grade-1", "softness")).toBeUndefined();
  });

  it("merges an explicit final value and cleans up on cancellation", () => {
    const onCommitMany = vi.fn();
    const { result } = renderHook(() =>
      useLiveParameterPreviewSession({
        transformId: "grade-2",
        onCommitMany,
      }),
    );

    act(() => {
      result.current.preview({ red: 0.1, green: 0.2 });
      result.current.commit({ red: 0.3 });
    });
    expect(onCommitMany).toHaveBeenCalledWith({ red: 0.3, green: 0.2 });

    act(() => {
      result.current.preview({ blue: 0.4 });
      result.current.cancel();
    });
    expect(livePreviewParamStore.get("grade-2", "blue")).toBeUndefined();
    expect(onCommitMany).toHaveBeenCalledOnce();
  });

  it("clears outstanding overrides when its owner unmounts", () => {
    const { result, unmount } = renderHook(() =>
      useLiveParameterPreviewSession({
        transformId: "grade-3",
        onCommitMany: vi.fn(),
      }),
    );
    act(() => result.current.preview({ exposure: 1 }));
    expect(livePreviewParamStore.get("grade-3", "exposure")).toBe(1);

    unmount();
    expect(livePreviewParamStore.get("grade-3", "exposure")).toBeUndefined();
  });
});
