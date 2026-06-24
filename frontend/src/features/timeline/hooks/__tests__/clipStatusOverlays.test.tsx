import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import {
  beginClipReversal,
  useClipReversalStore,
} from "../useClipReversalStore";
import { useTimelineClipMuteOverlay } from "../useTimelineClipMuteOverlay";
import { useTimelineReverseStatusOverlay } from "../useTimelineReverseStatusOverlay";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip-1",
    type: "audio",
    trackId: "track-1",
    start: 0,
    timelineDuration: 100,
    ...overrides,
  } as TimelineClip;
}

describe("timeline status overlays", () => {
  beforeEach(() => {
    useClipReversalStore.setState({ reversingClipIds: new Set() });
  });

  it("adds a mute indicator only for muted non-mask clips", () => {
    const definition = renderHook(() => useTimelineClipMuteOverlay()).result
      .current;
    expect(definition.id).toBe("timeline-clip-mute-overlay");
    const unmuted = renderHook(() =>
      definition.useItems({ clip: clip() } as never),
    );
    expect(unmuted.result.current).toEqual([]);
    const muted = renderHook(() =>
      definition.useItems({ clip: clip({ isMuted: true }) } as never),
    );
    expect(muted.result.current).toEqual([
      expect.objectContaining({
        id: "clip-mute-indicator",
        placement: expect.objectContaining({
          edge: "end",
          lane: "top",
        }),
      }),
    ]);
    const mask = renderHook(() =>
      definition.useItems({
        clip: clip({ type: "mask" }),
      } as never),
    );
    expect(mask.result.current).toEqual([]);
  });

  it("adds and removes the reverse rendering indicator reactively", () => {
    const definition = renderHook(() => useTimelineReverseStatusOverlay()).result
      .current;
    const items = renderHook(() =>
      definition.useItems({ clip: clip() } as never),
    );
    expect(items.result.current).toEqual([]);
    act(() => beginClipReversal("clip-1"));
    expect(items.result.current).toEqual([
      expect.objectContaining({
        id: "clip-reverse-status",
        placement: expect.objectContaining({
          edge: "start",
          lane: "middle",
        }),
      }),
    ]);
  });
});
