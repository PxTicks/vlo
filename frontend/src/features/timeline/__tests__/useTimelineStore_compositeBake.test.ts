import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineTrack, VideoTimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../constants";
import { useAssetStore } from "../../userAssets/useAssetStore";
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

describe("useTimelineStore.relinkCompositePlacements", () => {
  beforeEach(() => {
    useAssetStore.setState({
      assets: [
        {
          id: "bake-new",
          name: "bake-new.mp4",
          src: "bake-new.mp4",
          type: "video",
          hash: "hash-bake-new",
          duration: 120 / TICKS_PER_SECOND,
          createdAt: 1,
        },
      ],
    });
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1")],
        clips: [],
      });
    });
  });

  it("repoints every placement of a composite at the fresh bake and re-aligns timing", () => {
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
        .relinkCompositePlacements("composite-1", "bake-new");
    });

    const clips = useTimelineStore.getState().clips;
    const placement1 = clips.find((c) => c.id === "placement-1");
    const placement2 = clips.find((c) => c.id === "placement-2");
    const other = clips.find((c) => c.id === "other");

    for (const placement of [placement1, placement2]) {
      expect(placement).toMatchObject({
        assetId: "bake-new",
        sourceDuration: 120,
        timelineDuration: 120,
      });
    }
    expect(other).toMatchObject({ assetId: "bake-other" });
  });
});
