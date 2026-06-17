import { describe, it, expect } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { TimelineClipPresentationLookup } from "../../../timeline/utils/clipPresentation";
import { resolveLiveActiveClip } from "../clipLookup";

const clip = (id: string, extra: Partial<TimelineClip> = {}): TimelineClip =>
  ({
    id,
    trackId: "t1",
    type: "video",
    start: 0,
    timelineDuration: 100,
    ...extra,
  }) as TimelineClip;

function providerReturning(
  result:
    | { clipId: string; effectiveTick: number; presentationInputTick: number }
    | null,
): { getPresentationLookup: () => TimelineClipPresentationLookup } {
  const lookup: TimelineClipPresentationLookup = {
    findActiveClipAt: () => result,
    resolveEffectiveTrackTickWithinClip: (_clip, tick) => tick,
  };
  return { getPresentationLookup: () => lookup };
}

describe("resolveLiveActiveClip", () => {
  it("re-binds the lookup's clip id to the live clip (fresh data), keeping effectiveTick", () => {
    const provider = providerReturning({
      clipId: "c1",
      effectiveTick: 50,
      presentationInputTick: 25,
    });
    // The "live" clip carries newer data than whatever snapshot the lookup was
    // built from — re-binding by id must surface it.
    const live = clip("c1", {
      transformations: [
        { id: "b", type: "blur", isEnabled: true, parameters: { amount: 9 } },
      ],
    } as Partial<TimelineClip>);

    const resolved = resolveLiveActiveClip(provider, "t1", [live], 25);

    expect(resolved?.clip).toBe(live);
    expect(resolved?.effectiveTick).toBe(50);
  });

  it("returns null when the resolved id is absent from the live clips", () => {
    // e.g. clip was just deleted, or it is a synthetic lane clip the caller
    // must handle separately — never fall back to a stale cached object.
    const provider = providerReturning({
      clipId: "ghost",
      effectiveTick: 0,
      presentationInputTick: 0,
    });
    expect(resolveLiveActiveClip(provider, "t1", [clip("c1")], 10)).toBeNull();
  });

  it("returns null when the lookup finds no active clip", () => {
    const provider = providerReturning(null);
    expect(resolveLiveActiveClip(provider, "t1", [clip("c1")], 10)).toBeNull();
  });
});
