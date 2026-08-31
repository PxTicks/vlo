import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import {
  beginClipReversal,
  useClipReversalStore,
} from "../useClipReversalStore";
import { useTimelineClipMuteOverlay } from "../useTimelineClipMuteOverlay";
import { useTimelineStore } from "../../useTimelineStore";
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

  it("offers a mute toggle on audible clips and hides it on silent ones", () => {
    const definition = renderHook(() => useTimelineClipMuteOverlay()).result
      .current;
    expect(definition.id).toBe("timeline-clip-mute-overlay");
    const unmuted = renderHook(() =>
      definition.useItems({ clip: clip() } as never),
    );
    expect(unmuted.result.current).toEqual([
      expect.objectContaining({
        id: "clip-mute-toggle",
        placement: expect.objectContaining({
          edge: "end",
          lane: "top",
        }),
      }),
    ]);
    const muted = renderHook(() =>
      definition.useItems({ clip: clip({ isMuted: true }) } as never),
    );
    expect(muted.result.current).toEqual([
      expect.objectContaining({ id: "clip-mute-toggle" }),
    ]);
    const mask = renderHook(() =>
      definition.useItems({
        clip: clip({ type: "mask" }),
      } as never),
    );
    expect(mask.result.current).toEqual([]);
    const image = renderHook(() =>
      definition.useItems({ clip: clip({ type: "image" }) } as never),
    );
    expect(image.result.current).toEqual([]);
  });

  it("keeps the toggle on a silent clip that is already muted", () => {
    const definition = renderHook(() => useTimelineClipMuteOverlay()).result
      .current;
    const items = renderHook(() =>
      definition.useItems({
        clip: clip({ type: "image", isMuted: true }),
      } as never),
    );
    expect(items.result.current).toEqual([
      expect.objectContaining({ id: "clip-mute-toggle" }),
    ]);
  });

  it("toggles clip mute through the store when clicked", () => {
    useTimelineStore.setState({
      clips: [clip({ trackId: "track-1" })],
    } as never);
    const definition = renderHook(() => useTimelineClipMuteOverlay()).result
      .current;
    const items = renderHook(() =>
      definition.useItems({ clip: clip() } as never),
    );
    act(() => items.result.current[0]?.onClick?.());
    expect(
      useTimelineStore
        .getState()
        .clips.find((candidate) => candidate.id === "clip-1"),
    ).toMatchObject({ isMuted: true });
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
