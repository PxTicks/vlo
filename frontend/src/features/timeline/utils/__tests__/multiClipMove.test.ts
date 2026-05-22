import { describe, expect, it } from "vitest";
import type {
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { planMultiClipMove } from "../multiClipMove";

function createTrack(id: string, label: string, type?: TimelineTrack["type"]): TimelineTrack {
  return {
    id,
    label,
    type,
    isVisible: true,
    isLocked: false,
    isMuted: false,
  };
}

function createClip(
  id: string,
  trackId: string,
  start: number,
  duration: number,
): StandardTimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `asset_${id}`,
    start,
    timelineDuration: duration,
    offset: 0,
    croppedSourceDuration: duration,
    transformedOffset: 0,
    sourceDuration: duration,
    transformedDuration: duration,
    transformations: [],
  } as StandardTimelineClip;
}

describe("planMultiClipMove", () => {
  it("plans a grouped move into an inserted track without mutating the selection offsets", () => {
    const tracks = [
      createTrack("track-top", "Track 1"),
      createTrack("track-a", "Track 2", "visual"),
      createTrack("track-b", "Track 3", "visual"),
    ];
    const clipA = createClip("clip-a", "track-a", 0, 100);
    const clipB = createClip("clip-b", "track-b", 50, 100);
    const insertedTrack = createTrack("track-inserted", "Inserted");

    const plan = planMultiClipMove({
      clips: [clipA, clipB],
      selectedClipIds: [clipA.id, clipB.id],
      tracks,
      leaderClip: clipA,
      targetStartTicks: 120,
      ticksPerFrame: 1,
      insertedTrack,
      insertTrackIndex: 1,
    });

    expect(plan).toEqual([
      {
        clipId: clipA.id,
        start: 120,
        trackId: insertedTrack.id,
      },
      {
        clipId: clipB.id,
        start: 170,
        trackId: "track-a",
      },
    ]);
  });

  it("rejects a grouped move when one destination would collide", () => {
    const tracks = [
      createTrack("track-a", "Track 1", "visual"),
      createTrack("track-b", "Track 2", "visual"),
      createTrack("track-c", "Track 3", "visual"),
    ];
    const clipA = createClip("clip-a", "track-a", 0, 100);
    const clipB = createClip("clip-b", "track-b", 0, 100);
    const blocker = createClip("blocker", "track-c", 0, 100);

    const plan = planMultiClipMove({
      clips: [clipA, clipB, blocker],
      selectedClipIds: [clipA.id, clipB.id],
      tracks,
      leaderClip: clipA,
      targetStartTicks: 0,
      targetTrackId: "track-b",
      ticksPerFrame: 1,
    });

    expect(plan).toBeNull();
  });
});
