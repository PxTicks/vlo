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
import {
  getCompositeAssetById,
  getCompositeAssets,
  revealCompositeInBrowser,
  useCompositeLibraryStore,
} from "../useCompositeLibraryStore";

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
    revision: 1,
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
        schemaVersion: 2,
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
      bakeKey: "new-key",
    });

    await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: nextContent });

    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      id: current.id,
      bakedAssetId: "proxy-new",
      revision: 2,
      bake: {
        status: "ready",
        readyKey: "new-key",
        readyRevision: 2,
        assetId: "proxy-new",
      },
      content: nextContent,
    });
    expect(mocks.bakeComposite).toHaveBeenCalledWith(
      nextContent,
      expect.objectContaining({
        compositeAssetId: current.id,
        compositeRevision: 2,
      }),
    );
    // The placement must point at the new bake before the old one is deleted.
    const relinked = useTimelineStore
      .getState()
      .clips.find((clip) => clip.id === "clip-composite");
    expect(relinked).toMatchObject({
      assetId: "proxy-new",
      compositeRevision: 2,
      sourceDuration: TICKS_PER_SECOND,
      timelineDuration: TICKS_PER_SECOND,
    });
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
      bakeKey: "created-key",
    });

    await useCompositeLibraryStore.getState().createCompositeAsset({
      id: "composite-created",
      name: "Scene",
      content: content("clip-created"),
    });

    expect(useCompositeLibraryStore.getState().composites).toHaveLength(1);
    expect(useTimelineStore.getState().clips).toEqual([]);
  });

  it("fetches, clones, and sorts persisted composites", async () => {
    const older = composite({
      id: "older",
      name: "Zulu",
      updatedAt: 1,
    });
    const newerB = composite({
      id: "newer-b",
      name: "Beta",
      updatedAt: 5,
    });
    const newerA = composite({
      id: "newer-a",
      name: "Alpha",
      updatedAt: 5,
    });
    mocks.readCompositeLibrary.mockResolvedValue({
      composites: {
        older,
        "newer-b": newerB,
        "newer-a": newerA,
      },
    });

    await useCompositeLibraryStore.getState().fetchComposites();

    expect(
      useCompositeLibraryStore.getState().composites.map(({ id }) => id),
    ).toEqual(["newer-a", "newer-b", "older"]);
    expect(useCompositeLibraryStore.getState().isLoading).toBe(false);
  });

  it("clears loading state when persisted composite loading fails", async () => {
    mocks.readCompositeLibrary.mockRejectedValue(new Error("read failed"));
    await expect(
      useCompositeLibraryStore.getState().fetchComposites(),
    ).rejects.toThrow("read failed");
    expect(useCompositeLibraryStore.getState().isLoading).toBe(false);
  });

  it("generates identifiers, trims names, and forwards bake options", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    mocks.bakeComposite.mockResolvedValue({
      asset: bakedAsset("proxy-created"),
      bakedDurationTicks: TICKS_PER_SECOND,
      contentHash: "hash",
      bakeKey: "created-key",
    });

    const created = await useCompositeLibraryStore
      .getState()
      .createCompositeAsset({
        name: "  Named scene  ",
        content: content(),
        signal,
        onProgress,
      });

    expect(created).toMatchObject({
      id: "composite_00000000-0000-4000-8000-000000000001",
      name: "Named scene",
      createdAt: 100,
      updatedAt: 100,
      revision: 1,
      bake: {
        status: "ready",
        readyKey: "created-key",
        readyRevision: 1,
        assetId: "proxy-created",
      },
    });
    expect(mocks.bakeComposite).toHaveBeenCalledWith(
      expect.anything(),
      {
        signal,
        onProgress,
        compositeAssetId:
          "composite_00000000-0000-4000-8000-000000000001",
        compositeRevision: 1,
      },
    );
  });

  it("uses a default name and cleans up the bake if persistence fails", async () => {
    mocks.bakeComposite.mockResolvedValue({
      asset: bakedAsset("orphan"),
      bakedDurationTicks: null,
      contentHash: "hash",
      bakeKey: "orphan-key",
    });
    mocks.updateCompositeLibrary.mockRejectedValue(new Error("disk full"));

    await expect(
      useCompositeLibraryStore.getState().createCompositeAsset({
        id: "new",
        name: " ",
        content: content(),
      }),
    ).rejects.toThrow("disk full");
    expect(mocks.deleteAsset).toHaveBeenCalledWith("orphan");
    expect(useCompositeLibraryStore.getState().composites).toEqual([]);
  });

  it("returns null when updating a missing composite", async () => {
    await expect(
      useCompositeLibraryStore
        .getState()
        .updateCompositeAssetContent("missing", { content: content() }),
    ).resolves.toBeNull();
    expect(mocks.bakeComposite).not.toHaveBeenCalled();
  });

  it("rejects nested content during an update", async () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });
    const nested = content();
    nested.clips = nested.clips.map((clip) => ({
      ...clip,
      compositeId: "nested",
    }));

    await expect(
      useCompositeLibraryStore
        .getState()
        .updateCompositeAssetContent(current.id, { content: nested }),
    ).rejects.toThrow(/cannot contain other composites/i);
  });

  it("cleans a fresh update bake when persistence fails", async () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });
    mocks.bakeComposite.mockResolvedValue({
      asset: bakedAsset("proxy-failed"),
      bakedDurationTicks: TICKS_PER_SECOND,
      contentHash: "hash",
      bakeKey: "failed-key",
    });
    mocks.updateCompositeLibrary.mockRejectedValue(new Error("persist failed"));

    await expect(
      useCompositeLibraryStore
        .getState()
        .updateCompositeAssetContent(current.id, { content: content("next") }),
    ).rejects.toThrow("persist failed");
    expect(mocks.deleteAsset).toHaveBeenCalledWith("proxy-failed");
    expect(useCompositeLibraryStore.getState().composites[0]).toBe(current);
  });

  it("does not delete a bake when an update reuses its asset id", async () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });
    mocks.bakeComposite.mockResolvedValue({
      asset: bakedAsset("proxy-old"),
      bakedDurationTicks: null,
      contentHash: "hash",
      bakeKey: "same-key",
    });

    await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: content("next") });
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it("renames composites, ignores blank names, and rejects missing ids", async () => {
    vi.spyOn(Date, "now").mockReturnValue(20);
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });

    await useCompositeLibraryStore
      .getState()
      .renameCompositeAsset(current.id, "  Renamed  ");
    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      name: "Renamed",
      updatedAt: 20,
    });

    await useCompositeLibraryStore
      .getState()
      .renameCompositeAsset(current.id, "   ");
    expect(mocks.updateCompositeLibrary).toHaveBeenCalledTimes(1);
    await expect(
      useCompositeLibraryStore
        .getState()
        .renameCompositeAsset("missing", "Name"),
    ).rejects.toThrow("was not found");
  });

  it("ignores deleting missing composites and tolerates bake cleanup errors", async () => {
    await useCompositeLibraryStore
      .getState()
      .deleteCompositeAsset("missing");
    expect(mocks.updateCompositeLibrary).not.toHaveBeenCalled();

    const current = composite();
    useCompositeLibraryStore.setState({
      composites: [current],
      selectedCompositeIds: [current.id, "other"],
    });
    mocks.deleteAsset.mockRejectedValue(new Error("locked"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await useCompositeLibraryStore
      .getState()
      .deleteCompositeAsset(current.id);
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual([
      "other",
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("places existing composites and returns null for missing ids", () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });

    expect(
      useCompositeLibraryStore
        .getState()
        .placeCompositeAssetAtTime("missing", 10),
    ).toBeNull();
    const placedId = useCompositeLibraryStore
      .getState()
      .placeCompositeAssetAtTime(current.id, 100);
    expect(placedId).toEqual(expect.any(String));
    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        id: placedId,
        compositeId: current.id,
        compositeRevision: 1,
        assetId: "proxy-old",
        start: 100,
      }),
    ]);
  });

  it("supports single, additive, toggle, and cleared selection", () => {
    const state = useCompositeLibraryStore.getState();
    state.selectComposite("one");
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual([
      "one",
    ]);
    state.selectComposite("two", true);
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual([
      "one",
      "two",
    ]);
    state.selectComposite("one", true);
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual([
      "two",
    ]);
    state.selectComposite(null);
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual(
      [],
    );
    state.setSelectedCompositeIds(["a", "b"]);
    state.clearSelection();
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual(
      [],
    );
  });

  it("manages reveal requests and exposes public lookup helpers", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });

    revealCompositeInBrowser(current.id);
    expect(useCompositeLibraryStore.getState().revealRequest).toEqual({
      compositeAssetId: current.id,
      requestId: 123,
    });
    useCompositeLibraryStore.getState().clearRevealRequest(999);
    expect(useCompositeLibraryStore.getState().revealRequest).not.toBeNull();
    useCompositeLibraryStore.getState().clearRevealRequest(123);
    expect(useCompositeLibraryStore.getState().revealRequest).toBeNull();

    expect(getCompositeAssets()).toEqual([current]);
    expect(getCompositeAssetById(current.id)).toBe(current);
    expect(getCompositeAssetById(null)).toBeUndefined();
    expect(getCompositeAssetById("missing")).toBeUndefined();
  });
});
