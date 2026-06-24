import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginClipReversal,
  endClipReversal,
  useClipReversalStore,
  useIsClipReversing,
} from "../useClipReversalStore";

describe("useClipReversalStore", () => {
  beforeEach(() => {
    useClipReversalStore.setState({ reversingClipIds: new Set() });
  });

  it("tracks unique in-flight reversals and preserves no-op state", () => {
    const initial = useClipReversalStore.getState().reversingClipIds;
    act(() => beginClipReversal("clip-1"));
    const active = useClipReversalStore.getState().reversingClipIds;
    expect(active).not.toBe(initial);
    expect(active.has("clip-1")).toBe(true);

    beginClipReversal("clip-1");
    expect(useClipReversalStore.getState().reversingClipIds).toBe(active);
    endClipReversal("missing");
    expect(useClipReversalStore.getState().reversingClipIds).toBe(active);
    endClipReversal("clip-1");
    expect(useClipReversalStore.getState().reversingClipIds.has("clip-1")).toBe(
      false,
    );
  });

  it("exposes a reactive clip selector", () => {
    const { result, rerender } = renderHook(
      ({ clipId }) => useIsClipReversing(clipId),
      { initialProps: { clipId: "clip-1" as string | undefined } },
    );
    expect(result.current).toBe(false);
    act(() => beginClipReversal("clip-1"));
    expect(result.current).toBe(true);
    rerender({ clipId: undefined });
    expect(result.current).toBe(false);
  });
});
