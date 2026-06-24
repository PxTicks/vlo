import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../types/Asset";
import type {
  CompositeAsset,
  CompositeContent,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline/constants";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { createCompositeTimelineClip } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";

const mocks = vi.hoisted(() => ({
  bakeComposite: vi.fn(),
  deleteAsset: vi.fn(),
  readCompositeLibrary: vi.fn(),
  updateCompositeLibrary: vi.fn(),
}));

vi.mock("../services/bakeComposite", () => ({
  bakeComposite: mocks.bakeComposite,
}));

vi.mock("../../project", () => ({
  projectPersistenceService: {
    readCompositeLibrary: mocks.readCompositeLibrary,
    updateCompositeLibrary: mocks.updateCompositeLibrary,
  },
}));

vi.mock("../../userAssets", () => ({
  deleteAsset: mocks.deleteAsset,
}));

const track: TimelineTrack = {
  id: "track-1",
  label: "Track 1",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

function content(id = "clip-1"): CompositeContent {
  return {
    durationTicks: TICKS_PER_SECOND,
    tracks: [track],
    clips: [
      {
        id,
        type: "image",
        name: "Still",
        assetId: "asset-1",
        trackId: track.id,
        start: 0,
        sourceDuration: TICKS_PER_SECOND,
        timelineDuration: TICKS_PER_SECOND,
        croppedSourceDuration: TICKS_PER_SECOND,
        offset: 0,
        transformedDuration: TICKS_PER_SECOND,
        transformedOffset: 0,
        transformations: [],
      },
    ],
  };
}

function bakedAsset(id: string): Asset {
  return {
    id,
    hash: `${id}-hash`,
    name: `${id}.mp4`,
    type: "video",
    src: `assets/${id}.mp4`,
    duration: 1,
    createdAt: 1,
  };
}

function composite(overrides: Partial<CompositeAsset> = {}): CompositeAsset {
  return {
    id: "composite-1",
    name: "Composite",
    content: content(),
    bakedAssetId: "proxy-old",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

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

describe("useCompositeLibraryStore", () => {
  beforeEach(() => {
    mocks.bakeComposite.mockReset();
    mocks.deleteAsset.mockReset();
    mocks.readCompositeLibrary.mockReset();
    mocks.updateCompositeLibrary.mockReset();
    mocks.updateCompositeLibrary.mockImplementation(async (mutator) => {
      const document = {
        documentType: "vlo.composites",
        schemaVersion: 1,
        updated_at: 1,
        composites: {},
      };
      mutator(document);
      return document;
    });
    useCompositeLibraryStore.setState({
      composites: [],
      isLoading: false,
      selectedCompositeIds: [],
      revealRequest: null,
      ...compositeLibraryActions,
    });
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [],
    });
  });

  it("swaps the bake, relinks placements, and deletes the old bake after edits", async () => {
    const current = composite();
    const nextContent = content("clip-edited");
    const placement = createCompositeTimelineClip({
      id: "clip-composite",
      compositeId: current.id,
      assetId: "proxy-old",
      durationTicks: current.content.durationTicks,
      trackId: track.id,
      start: 0,
      name: current.name,
    });
    useCompositeLibraryStore.setState({ composites: [current] });
    useTimelineStore.getState().addClip(placement);
    mocks.bakeComposite.mockResolvedValueOnce({
      asset: bakedAsset("proxy-new"),
      bakedDurationTicks: TICKS_PER_SECOND,
      contentHash: "new-hash",
    });

    await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: nextContent });

    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      id: current.id,
      bakedAssetId: "proxy-new",
      content: nextContent,
    });
    // The placement must point at the new bake before the old one is deleted.
    const relinked = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === "clip-composite");
    expect(relinked).toMatchObject({ assetId: "proxy-new" });
    expect(mocks.deleteAsset).toHaveBeenCalledWith("proxy-old");
  });

  it("rejects content that nests another composite", async () => {
    const base = content("clip-nested");
    const nested = {
      ...base,
      // Tag the content's clip as a composite placement → nesting.
      clips: base.clips.map((clip) => ({
        ...clip,
        compositeId: "other-composite",
      })),
    };

    await expect(
      useCompositeLibraryStore
        .getState()
        .createCompositeAsset({ content: nested }),
    ).rejects.toThrow(/cannot contain other composites/i);
    expect(mocks.bakeComposite).not.toHaveBeenCalled();
  });

  it("deletes timeline placements and proxy assets when deleting a composite", async () => {
    const current = composite();
    const placement = createCompositeTimelineClip({
      id: "clip-composite",
      compositeId: current.id,
      assetId: current.bakedAssetId ?? "bake",
      durationTicks: current.content.durationTicks,
      trackId: track.id,
      start: 0,
      name: current.name,
    });
    useCompositeLibraryStore.setState({ composites: [current] });
    useTimelineStore.getState().addClip(placement);

    await useCompositeLibraryStore.getState().deleteCompositeAsset(current.id);

    expect(useCompositeLibraryStore.getState().composites).toEqual([]);
    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(mocks.deleteAsset).toHaveBeenCalledWith("proxy-old");
  });

  it("creates browser-only composites without placing timeline clips", async () => {
    mocks.bakeComposite.mockResolvedValueOnce({
      asset: bakedAsset("proxy-created"),
      bakedDurationTicks: TICKS_PER_SECOND,
      contentHash: "created-hash",
    });

    await useCompositeLibraryStore.getState().createCompositeAsset({
      id: "composite-created",
      name: "Scene",
      content: content("clip-created"),
    });

    expect(useCompositeLibraryStore.getState().composites).toHaveLength(1);
    expect(useTimelineStore.getState().clips).toEqual([]);
  });
});
