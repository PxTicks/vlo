import { describe, expect, it, beforeEach, vi } from "vitest";
import { useTimelineStore } from "../useTimelineStore";
import type { TimelineClip } from "../../../types/TimelineTypes";

function clip(id: string, trackId: string, start: number, duration: number): TimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    start,
    timelineDuration: duration,
    offset: 0,
    croppedSourceDuration: duration,
    transformedOffset: 0,
    transformedDuration: duration,
    sourceDuration: duration,
    transformations: [],
    assetId: `asset-${id}`,
  } as TimelineClip;
}

describe("useTimelineStore — render groups", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      tracks: [
        { id: "track-1", label: "Track 1", isVisible: true, isMuted: false, isLocked: false, type: "visual" },
        { id: "track-2", label: "Track 2", isVisible: true, isMuted: false, isLocked: false, type: "visual" },
        { id: "track-3", label: "Track 3", isVisible: true, isMuted: false, isLocked: false, type: "visual" },
      ],
      clips: [],
      groups: [],
      selectedClipIds: [],
    });
  });

  it("createGroup adds a TimelineGroup and returns its id", () => {
    const id = useTimelineStore.getState().createGroup({
      label: "Adjustment",
      trackIds: ["track-1", "track-2"],
      start: 0,
      timelineDuration: 100,
    });
    expect(id).toBeTruthy();
    const groups = useTimelineStore.getState().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Adjustment");
    expect(groups[0].trackIds).toEqual(["track-1", "track-2"]);
  });

  it("createGroup returns null and leaves state unchanged when invariants fail", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Non-contiguous (track-1 + track-3, skip track-2)
    const id = useTimelineStore.getState().createGroup({
      trackIds: ["track-1", "track-3"],
      start: 0,
      timelineDuration: 100,
    });
    expect(id).toBeNull();
    expect(useTimelineStore.getState().groups).toEqual([]);

    vi.restoreAllMocks();
  });

  it("deleteGroup removes the group without touching tracks or clips", () => {
    useTimelineStore.setState({
      clips: [clip("clip-1", "track-1", 0, 100)],
    });
    const id = useTimelineStore.getState().createGroup({
      trackIds: ["track-1"],
      start: 0,
      timelineDuration: 100,
    });
    expect(id).toBeTruthy();
    expect(useTimelineStore.getState().deleteGroup(id!)).toBe(true);
    expect(useTimelineStore.getState().groups).toEqual([]);
    expect(useTimelineStore.getState().tracks).toHaveLength(3);
    expect(useTimelineStore.getState().clips).toHaveLength(1);
  });

  it("setGroupTimeRange / setGroupVisibility round-trip through the store", () => {
    const id = useTimelineStore.getState().createGroup({
      trackIds: ["track-1"],
      start: 0,
      timelineDuration: 100,
    });
    expect(useTimelineStore.getState().setGroupTimeRange(id!, 50, 25)).toBe(true);
    expect(useTimelineStore.getState().groups[0]).toMatchObject({
      start: 50,
      timelineDuration: 25,
    });

    expect(useTimelineStore.getState().setGroupVisibility(id!, false)).toBe(true);
    expect(useTimelineStore.getState().groups[0].isVisible).toBe(false);
  });

  it("trimAndPadTracks scrubs orphaned trackIds from groups", () => {
    // Seed clips on track-1 and track-2 only; track-3 will be trimmed.
    useTimelineStore.setState({
      clips: [
        clip("clip-1", "track-1", 0, 100),
        clip("clip-2", "track-2", 0, 100),
      ],
    });
    const id = useTimelineStore.getState().createGroup({
      trackIds: ["track-1", "track-2"],
      start: 0,
      timelineDuration: 100,
    });
    expect(id).toBeTruthy();

    // Removing track-2's clip should let trimAndPadTracks drop track-2 (or its
    // surrounding pad shape), and the group should lose any orphaned ids.
    useTimelineStore.getState().removeClip("clip-2");
    useTimelineStore.getState().trimAndPadTracks();

    const liveTrackIds = new Set(
      useTimelineStore.getState().tracks.map((t) => t.id),
    );
    const group = useTimelineStore.getState().groups[0];
    for (const id of group.trackIds) {
      expect(liveTrackIds.has(id)).toBe(true);
    }
  });
});
