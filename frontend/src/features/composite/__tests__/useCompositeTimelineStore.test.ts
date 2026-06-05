import { beforeEach, describe, expect, it, vi } from "vitest";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { TICKS_PER_SECOND } from "../../timeline/constants";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";
import { useCompositeTimelineStore } from "../useCompositeTimelineStore";
import { createCompositeTimelineClip } from "../utils/createCompositeClip";
import type {
  CompositeAsset,
  CompositeContent,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { isCompositeClip } from "../../../types/TimelineTypes";

const compositeLibraryActions = {
  fetchComposites: useCompositeLibraryStore.getState().fetchComposites,
  createCompositeAsset: useCompositeLibraryStore.getState().createCompositeAsset,
  updateCompositeAssetContent:
    useCompositeLibraryStore.getState().updateCompositeAssetContent,
  renameCompositeAsset: useCompositeLibraryStore.getState().renameCompositeAsset,
  deleteCompositeAsset: useCompositeLibraryStore.getState().deleteCompositeAsset,
  placeCompositeAssetAtTime:
    useCompositeLibraryStore.getState().placeCompositeAssetAtTime,
  selectComposite: useCompositeLibraryStore.getState().selectComposite,
  setSelectedCompositeIds:
    useCompositeLibraryStore.getState().setSelectedCompositeIds,
  clearSelection: useCompositeLibraryStore.getState().clearSelection,
  revealCompositeInBrowser:
    useCompositeLibraryStore.getState().revealCompositeInBrowser,
  clearRevealRequest: useCompositeLibraryStore.getState().clearRevealRequest,
};

const mainTrack: TimelineTrack = {
  id: "main-track",
  label: "Track 1",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const innerTrack: TimelineTrack = {
  id: "inner-track",
  label: "Inner Track",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const innerClip: TimelineClip = {
  id: "inner-clip",
  type: "image",
  name: "Inner Clip",
  trackId: innerTrack.id,
  start: 0,
  sourceDuration: TICKS_PER_SECOND,
  timelineDuration: TICKS_PER_SECOND,
  croppedSourceDuration: TICKS_PER_SECOND,
  offset: 0,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  transformations: [],
  assetId: "asset-inner",
};

function seedTimeline(clips: TimelineClip[], tracks: TimelineTrack[] = [mainTrack]) {
  useTimelineStore.getState().setTimelinePersistenceSuspended(false);
  useTimelineStore.getState().replaceTimelineSnapshot({ tracks, clips });
}

function resetCompositeStore() {
  useCompositeTimelineStore.setState({
    stack: [],
    isBusy: false,
    lastError: null,
  });
  useCompositeLibraryStore.setState({
    composites: [],
    isLoading: false,
    selectedCompositeIds: [],
    revealRequest: null,
    ...compositeLibraryActions,
  });
}

function compositeAsset(
  overrides: Partial<CompositeAsset> = {},
): CompositeAsset {
  const content: CompositeContent = {
    durationTicks: TICKS_PER_SECOND,
    clips: [innerClip],
    tracks: [innerTrack],
  };
  return {
    id: "composite-asset-1",
    name: "Composite",
    content,
    bakedAssetId: "old-proxy",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("useCompositeTimelineStore", () => {
  beforeEach(() => {
    resetCompositeStore();
    seedTimeline([]);
    playbackClock.setTime(0);
  });

  it("opens a composite asset as an editable subtimeline and saves edits back to the library", async () => {
    const composite = compositeAsset();
    const updateCompositeAssetContent = vi
      .fn()
      .mockImplementation(
        async (
          compositeAssetId: string,
          input: { content: CompositeContent },
        ) => {
          const updated = {
            ...composite,
            id: compositeAssetId,
            content: input.content,
            updatedAt: 2,
          };
          useCompositeLibraryStore.setState({ composites: [updated] });
          return updated;
        },
      );
    useCompositeLibraryStore.setState({
      composites: [composite],
      updateCompositeAssetContent,
    });
    const compositeClip = createCompositeTimelineClip({
      compositeId: composite.id,
      assetId: composite.bakedAssetId ?? "bake",
      durationTicks: composite.content.durationTicks,
      trackId: mainTrack.id,
      start: 0,
      name: composite.name,
    });
    seedTimeline([compositeClip]);

    expect(
      useCompositeTimelineStore.getState().openCompositeAsset(composite.id),
    ).toBe(true);

    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
    ]);

    const addedClip: TimelineClip = {
      ...innerClip,
      id: "added-inner-clip",
      start: TICKS_PER_SECOND,
    };
    useTimelineStore.getState().addClip(addedClip);

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    const [savedClip] = useTimelineStore.getState().clips;
    expect(savedClip.id).toBe(compositeClip.id);
    expect(isCompositeClip(savedClip)).toBe(true);
    expect(updateCompositeAssetContent).toHaveBeenCalledWith(
      composite.id,
      expect.objectContaining({
        content: expect.objectContaining({
          durationTicks: 2 * TICKS_PER_SECOND,
          clips: expect.arrayContaining([
            expect.objectContaining({ id: innerClip.id }),
            expect.objectContaining({ id: addedClip.id }),
          ]),
        }),
      }),
    );
    expect(useCompositeTimelineStore.getState().stack).toEqual([]);
  });

  it("creates a blank scene subtimeline as a browser composite asset only", async () => {
    const createCompositeAsset = vi.fn().mockResolvedValue(compositeAsset());
    useCompositeLibraryStore.setState({ createCompositeAsset });
    playbackClock.setTime(12_000);
    seedTimeline([]);

    expect(useCompositeTimelineStore.getState().startBlankSubtimeline()).toBe(
      true,
    );
    expect(useTimelineStore.getState().clips).toEqual([]);

    useTimelineStore.getState().addClip({
      ...innerClip,
      trackId: useTimelineStore.getState().tracks[0].id,
    });

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(createCompositeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Scene",
        content: expect.objectContaining({ clips: expect.any(Array) }),
      }),
    );
  });

  it("returns to the main timeline without inserting an untouched blank scene", async () => {
    playbackClock.setTime(12_000);
    seedTimeline([]);

    expect(useCompositeTimelineStore.getState().startBlankSubtimeline()).toBe(
      true,
    );

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    expect(useTimelineStore.getState().clips).toEqual([]);
  });
});
