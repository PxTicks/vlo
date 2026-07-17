import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineTrack, VideoTimelineClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  type: "visual",
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

/** A composite placement is an ordinary video clip tagged with `compositeId`. */
function compositePlacement(
  id: string,
  compositeId: string,
  assetId: string,
): VideoTimelineClip {
  return {
    id,
    trackId: "track-1",
    type: "video",
    name: id,
    assetId,
    compositeId,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
  };
}

describe("useTimelineStore.syncCompositePlacementRevision", () => {
  beforeEach(() => {
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1")],
        clips: [],
      });
    });
  });

  it("updates revision identity without changing cache pointers or authored timing", () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositePlacement("placement-1", "composite-1", "bake-old"));
      useTimelineStore
        .getState()
        .addClip(compositePlacement("placement-2", "composite-1", "bake-old"));
      // An unrelated composite's placement must be left untouched.
      useTimelineStore
        .getState()
        .addClip(compositePlacement("other", "composite-2", "bake-other"));
      useTimelineStore
        .getState()
        .syncCompositePlacementRevision("composite-1", 2);
    });

    const clips = useTimelineStore.getState().clips;
    const placement1 = clips.find((c) => c.id === "placement-1");
    const placement2 = clips.find((c) => c.id === "placement-2");
    const other = clips.find((c) => c.id === "other");

    for (const placement of [placement1, placement2]) {
      expect(placement).toMatchObject({
        assetId: "bake-old",
        compositeRevision: 2,
        sourceDuration: 100,
        timelineDuration: 100,
        croppedSourceDuration: 100,
        transformedDuration: 100,
      });
    }
    expect(other).toMatchObject({ assetId: "bake-other" });
  });

  it("remaps only the edited placement to a forked composite", () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositePlacement("edited", "composite-1", "bake-old"));
      useTimelineStore
        .getState()
        .addClip(compositePlacement("shared", "composite-1", "bake-old"));
    });

    expect(
      useTimelineStore
        .getState()
        .remapCompositePlacement(
          "edited",
          "composite-1",
          "composite-fork",
          1,
        ),
    ).toBe(true);

    expect(useTimelineStore.getState().clips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edited",
          compositeId: "composite-fork",
          compositeRevision: 1,
          assetId: "composite-live:composite-fork",
        }),
        expect.objectContaining({
          id: "shared",
          compositeId: "composite-1",
          assetId: "bake-old",
        }),
      ]),
    );
  });

  it("does not overwrite a placement that no longer references the expected composite", () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositePlacement("edited", "composite-new", "bake-new"));
    });

    expect(
      useTimelineStore
        .getState()
        .remapCompositePlacement(
          "edited",
          "composite-old",
          "composite-fork",
          1,
        ),
    ).toBe(false);
    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        id: "edited",
        compositeId: "composite-new",
        assetId: "bake-new",
      }),
    ]);
  });
});
