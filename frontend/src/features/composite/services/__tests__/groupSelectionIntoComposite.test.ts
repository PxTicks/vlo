import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { createTimelineSelection } from "../../../timelineSelection";
import { useCompositeLibraryStore } from "../../useCompositeLibraryStore";
import type {
  CompositeAsset,
  CompositeContent,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { groupSelectionIntoComposite } from "../groupSelectionIntoComposite";

const SECOND = 96000;

function track(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function videoClip(id: string, trackId: string, start: number): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `${id}-asset`,
    start,
    timelineDuration: SECOND,
    sourceDuration: 4 * SECOND,
    transformedDuration: 4 * SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 4 * SECOND,
    offset: 0,
    transformations: [],
  };
}

const createCompositeAsset = vi.fn();
const deleteCompositeAsset = vi.fn();
const { groupClipsIntoComposite: realGroupClipsIntoComposite } =
  useTimelineStore.getState();

describe("groupSelectionIntoComposite", () => {
  beforeEach(() => {
    createCompositeAsset.mockReset();
    deleteCompositeAsset.mockReset();
    createCompositeAsset.mockImplementation(
      async ({ name, content }: { name?: string; content: CompositeContent }) =>
        ({
          id: "composite-1",
          name: name ?? "Composite",
          content,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }) satisfies CompositeAsset,
    );
    useCompositeLibraryStore.setState({
      createCompositeAsset,
      deleteCompositeAsset,
    });
    useProjectStore.setState((state) => ({
      ...state,
      config: { ...state.config, fps: 30 },
    }));
    useTimelineStore.setState({
      tracks: [track("upper"), track("lower")],
      clips: [
        videoClip("a", "lower", 0),
        videoClip("b", "upper", SECOND),
        videoClip("outside", "lower", 5 * SECOND),
      ],
      transitions: [],
      selectedClipIds: [],
    });
  });

  afterEach(() => {
    useTimelineStore.setState({
      groupClipsIntoComposite: realGroupClipsIntoComposite,
    });
  });

  it("replaces the selected clips with one composite on the highest occupied track", async () => {
    const onProgress = vi.fn();
    const controller = new AbortController();
    const clip = await groupSelectionIntoComposite(
      createTimelineSelection(0, 2 * SECOND),
      { name: "Intro", signal: controller.signal, onProgress },
    );

    expect(clip).toMatchObject({
      type: "video",
      name: "Intro",
      compositeId: "composite-1",
      trackId: "upper",
      start: 0,
    });
    const input = createCompositeAsset.mock.calls[0][0];
    expect(input).toMatchObject({
      name: "Intro",
      signal: controller.signal,
      onProgress,
    });
    // Content tracks are re-namespaced away from the live timeline's ids.
    const contentTrackIds = input.content.tracks.map(
      (contentTrack: TimelineTrack) => contentTrack.id,
    );
    expect(contentTrackIds).not.toContain("upper");
    expect(contentTrackIds).not.toContain("lower");

    const clipIds = useTimelineStore.getState().clips.map((entry) => entry.id);
    expect(clipIds).toContain(clip?.id);
    expect(clipIds).toContain("outside");
    expect(clipIds).not.toContain("a");
    expect(clipIds).not.toContain("b");
    expect(deleteCompositeAsset).not.toHaveBeenCalled();
  });

  it("deletes the new asset when the timeline refuses the swap", async () => {
    const groupClipsIntoComposite = vi.fn(() => false);
    useTimelineStore.setState({ groupClipsIntoComposite });

    const clip = await groupSelectionIntoComposite(
      createTimelineSelection(0, 2 * SECOND),
    );

    expect(clip).toBeNull();
    expect(groupClipsIntoComposite).toHaveBeenCalled();
    expect(deleteCompositeAsset).toHaveBeenCalledWith("composite-1");
  });

  it("returns null without creating an asset when there is no track to place on", async () => {
    useTimelineStore.setState({ tracks: [], clips: [] });
    const clip = await groupSelectionIntoComposite(
      createTimelineSelection(0, SECOND),
    );
    expect(clip).toBeNull();
    expect(createCompositeAsset).not.toHaveBeenCalled();
  });
});
