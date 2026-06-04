import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompositeTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";

vi.mock("../../userAssets", () => ({
  deleteAsset: vi.fn(async () => undefined),
}));

import { useTimelineStore } from "../useTimelineStore";

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  type: "visual",
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

function videoClip(id: string, trackId: string, start: number): VideoTimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `asset-${id}`,
    start,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
  };
}

function compositeClip(id: string, trackId: string): CompositeTimelineClip {
  return {
    id,
    trackId,
    type: "composite",
    name: "Composite",
    start: 0,
    timelineDuration: 200,
    offset: 0,
    croppedSourceDuration: 200,
    transformedOffset: 0,
    sourceDuration: 200,
    transformedDuration: 200,
    transformations: [],
    proxyAssetId: "proxy-1",
    proxyContentHash: "hash-1",
    content: {
      durationTicks: 200,
      clips: [],
    },
  };
}

describe("useTimelineStore.groupClipsIntoComposite", () => {
  beforeEach(() => {
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1"), createTrack("track-2")],
        clips: [
          videoClip("clip-a", "track-1", 0),
          videoClip("clip-b", "track-2", 100),
        ],
      });
    });
  });

  it("does not wipe the timeline when the whole timeline is grouped", () => {
    const composite = compositeClip("composite-1", "track-1");

    act(() => {
      useTimelineStore
        .getState()
        .groupClipsIntoComposite(["clip-a", "clip-b"], composite);
    });

    const { clips, tracks } = useTimelineStore.getState();

    // The composite must survive and the source clips must be gone.
    expect(clips.map((c) => c.id)).toEqual(["composite-1"]);

    // The composite must live on a track that actually exists, otherwise it is
    // orphaned and the timeline renders empty (the catastrophic wipe).
    const trackIds = new Set(tracks.map((t) => t.id));
    expect(trackIds.has(clips[0].trackId)).toBe(true);
  });
});
