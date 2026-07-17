import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../types/Asset";
import type {
  CompositeAsset,
  CompositeContent,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline/constants";
import { runProjectClosingHooks } from "../../../core/project/projectLifecycleHooks";
import { useProjectStore } from "../../project/useProjectStore";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { compositeBakeQueue } from "../services/CompositeBakeQueue";
import type { BakedComposite } from "../services/bakeComposite";
import type { BakeCompositeOptions } from "../services/bakeComposite";
import { createCompositeTimelineClip } from "../utils/createCompositeClip";
import {
  getCompositeAssetById,
  getCompositeAssets,
  revealCompositeInBrowser,
  useCompositeLibraryStore,
} from "../useCompositeLibraryStore";

const mocks = vi.hoisted(() => ({
  assets: [] as Asset[],
  bakeComposite: vi.fn(),
  deleteAsset: vi.fn(),
  readCompositeLibrary: vi.fn(),
  updateCompositeLibrary: vi.fn(),
  waitForAssetPersistence: vi.fn(),
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
  getAssetById: (id: string) => mocks.assets.find((asset) => asset.id === id),
  getAssets: () => mocks.assets,
  waitForAssetPersistence: mocks.waitForAssetPersistence,
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

function bakedAsset(
  id: string,
  compositeId: string,
  revision: number,
  bakeKey: string,
): Asset {
  return {
    id,
    hash: `${id}-hash`,
    name: `${id}.webm`,
    type: "video",
    src: `blob:${id}`,
    duration: 1,
    createdAt: 1,
    creationMetadata: {
      source: "composite",
      compositeAssetId: compositeId,
      compositeRevision: revision,
      bakeKey,
    },
  };
}

function bakedResult(asset: Asset, bakeKey: string): BakedComposite {
  mocks.assets.push(asset);
  return {
    asset,
    contentHash: `${asset.id}-content`,
    bakeKey,
  };
}

function composite(overrides: Partial<CompositeAsset> = {}): CompositeAsset {
  return {
    id: "composite-1",
    name: "Composite",
    content: content(),
    bakedAssetId: "proxy-old",
    revision: 1,
    bake: {
      status: "ready",
      requestedKey: "old-key",
      readyKey: "old-key",
      readyRevision: 1,
      assetId: "proxy-old",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const actions = {
  fetchComposites: useCompositeLibraryStore.getState().fetchComposites,
  createCompositeAsset: useCompositeLibraryStore.getState().createCompositeAsset,
  updateCompositeAssetContent:
    useCompositeLibraryStore.getState().updateCompositeAssetContent,
  retryCompositeBake: useCompositeLibraryStore.getState().retryCompositeBake,
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
  beforeEach(async () => {
    compositeBakeQueue.cancelAll();
    await compositeBakeQueue.whenIdle();
    vi.clearAllMocks();
    mocks.assets = [
      {
        id: "asset-1",
        hash: "source-hash",
        name: "source.png",
        type: "image",
        src: "blob:source",
        createdAt: 1,
      },
    ];
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
      ...actions,
    });
    useProjectStore.setState({
      project: {
        id: "project-1",
        title: "Project",
        rootAssetsFolder: "Project",
        createdAt: 1,
        lastModified: 1,
      },
    });
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [],
    });
  });

  it("commits creation before its background bake completes", async () => {
    let finishBake: (result: BakedComposite) => void = () => undefined;
    mocks.bakeComposite.mockImplementationOnce(
      () =>
        new Promise<BakedComposite>((resolve) => {
          finishBake = resolve;
        }),
    );

    const created = await useCompositeLibraryStore
      .getState()
      .createCompositeAsset({
        id: "created",
        name: " Scene ",
        content: content("created-child"),
      });

    expect(created).toMatchObject({
      id: "created",
      name: "Scene",
      revision: 1,
      bake: {
        status: expect.stringMatching(/queued|rendering/),
        requestedKey: expect.any(String),
      },
    });
    expect(created.bakedAssetId).toBeUndefined();
    expect(useCompositeLibraryStore.getState().composites).toHaveLength(1);
    await vi.waitFor(() => expect(mocks.bakeComposite).toHaveBeenCalledOnce());

    const requestedKey = created.bake?.requestedKey ?? "";
    finishBake(
      bakedResult(
        bakedAsset("created-bake", created.id, 1, requestedKey),
        requestedKey,
      ),
    );
    await compositeBakeQueue.whenIdle();
    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      bakedAssetId: "created-bake",
      bake: { status: "ready", assetId: "created-bake" },
    });
  });

  it("publishes edited content immediately and relinks only after CAS publication", async () => {
    const current = composite();
    mocks.assets.push(
      bakedAsset("proxy-old", current.id, 1, current.bake?.readyKey ?? "old-key"),
    );
    const placement = createCompositeTimelineClip({
      id: "placement",
      compositeId: current.id,
      compositeRevision: 1,
      assetId: "proxy-old",
      durationTicks: current.content.durationTicks,
      trackId: track.id,
      start: 0,
    });
    useCompositeLibraryStore.setState({ composites: [current] });
    useTimelineStore.getState().addClip(placement);
    let finishBake: (result: BakedComposite) => void = () => undefined;
    mocks.bakeComposite.mockImplementationOnce(
      () =>
        new Promise<BakedComposite>((resolve) => {
          finishBake = resolve;
        }),
    );

    const updated = await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: content("edited") });
    expect(updated).toMatchObject({
      revision: 2,
      content: expect.objectContaining({
        clips: [expect.objectContaining({ id: "edited" })],
      }),
      bake: { status: "queued" },
    });
    expect(useTimelineStore.getState().clips[0]).toMatchObject({
      assetId: "proxy-old",
      compositeRevision: 2,
      timelineDuration: TICKS_PER_SECOND,
    });

    await vi.waitFor(() => expect(mocks.bakeComposite).toHaveBeenCalledOnce());
    const requestedKey = updated?.bake?.requestedKey ?? "";
    finishBake(
      bakedResult(
        bakedAsset("proxy-new", current.id, 2, requestedKey),
        requestedKey,
      ),
    );
    await compositeBakeQueue.whenIdle();
    expect(useTimelineStore.getState().clips[0]).toMatchObject({
      assetId: "proxy-new",
      compositeRevision: 2,
      timelineDuration: TICKS_PER_SECOND,
    });
    expect(mocks.deleteAsset).toHaveBeenCalledWith("proxy-old", {
      cleanupMode: "immediate",
    });
  });

  it("rejects a stale completion after a newer revision is committed", async () => {
    const current = composite({ bakedAssetId: undefined, bake: undefined });
    useCompositeLibraryStore.setState({ composites: [current] });
    const finishes: Array<(result: BakedComposite) => void> = [];
    mocks.bakeComposite.mockImplementation(
      () =>
        new Promise<BakedComposite>((resolve) => {
          finishes.push(resolve);
        }),
    );

    const revision2 = await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: content("revision-2") });
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    const revision3 = await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: content("revision-3") });

    const staleKey = revision2?.bake?.requestedKey ?? "";
    finishes[0](
      bakedResult(
        bakedAsset("stale-bake", current.id, 2, staleKey),
        staleKey,
      ),
    );
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    const latestKey = revision3?.bake?.requestedKey ?? "";
    finishes[1](
      bakedResult(
        bakedAsset("latest-bake", current.id, 3, latestKey),
        latestKey,
      ),
    );
    await compositeBakeQueue.whenIdle();

    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      revision: 3,
      bakedAssetId: "latest-bake",
      bake: { readyRevision: 3, assetId: "latest-bake" },
    });
    expect(mocks.deleteAsset).toHaveBeenCalledWith("stale-bake", {
      cleanupMode: "immediate",
    });
  });

  it("records a retryable failure without rolling back canonical content", async () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });
    mocks.bakeComposite.mockRejectedValueOnce(new Error("encoder unavailable"));

    await useCompositeLibraryStore
      .getState()
      .updateCompositeAssetContent(current.id, { content: content("edited") });
    await compositeBakeQueue.whenIdle();
    expect(useCompositeLibraryStore.getState().composites[0]).toMatchObject({
      revision: 2,
      content: expect.objectContaining({
        clips: [expect.objectContaining({ id: "edited" })],
      }),
      bake: { status: "failed", error: "encoder unavailable" },
    });
  });

  it("retries the current revision and reaches ready", async () => {
    const failed = composite({
      bake: {
        status: "failed",
        requestedKey: "stale-key",
        error: "failed",
        assetId: "proxy-old",
      },
    });
    useCompositeLibraryStore.setState({ composites: [failed] });
    mocks.bakeComposite.mockImplementationOnce(async (_content, options) => {
      const requestedKey = useCompositeLibraryStore.getState().composites[0].bake
        ?.requestedKey ?? "";
      return bakedResult(
        bakedAsset("retry-bake", failed.id, options.compositeRevision ?? 1, requestedKey),
        requestedKey,
      );
    });

    await expect(
      useCompositeLibraryStore.getState().retryCompositeBake(failed.id),
    ).resolves.toBe(true);
    await compositeBakeQueue.whenIdle();
    expect(useCompositeLibraryStore.getState().composites[0].bake).toMatchObject({
      status: "ready",
      assetId: "retry-bake",
      readyRevision: 1,
    });
  });

  it("normalizes interrupted persisted jobs and queues repair after load", async () => {
    const interrupted = composite({
      bake: { status: "rendering", requestedKey: "interrupted" },
    });
    mocks.readCompositeLibrary.mockResolvedValue({
      composites: { [interrupted.id]: interrupted },
    });
    mocks.bakeComposite.mockRejectedValueOnce(new Error("repair failed"));

    await useCompositeLibraryStore.getState().fetchComposites();
    expect(useCompositeLibraryStore.getState().composites[0].bake).toMatchObject({
      status: expect.stringMatching(/queued|rendering/),
      requestedKey: expect.not.stringMatching(/^interrupted$/),
    });
    await compositeBakeQueue.whenIdle();
  });

  it("aborts and drains background work when the project closes", async () => {
    let bakeSignal: AbortSignal | undefined;
    mocks.bakeComposite.mockImplementationOnce(
      (_content: CompositeContent, options: BakeCompositeOptions) =>
        new Promise((_resolve, reject) => {
          bakeSignal = options.signal;
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          });
        }),
    );
    await useCompositeLibraryStore.getState().createCompositeAsset({
      id: "closing",
      content: content("closing-child"),
    });
    await vi.waitFor(() => expect(bakeSignal).toBeDefined());

    await runProjectClosingHooks();

    expect(bakeSignal?.aborted).toBe(true);
    expect(compositeBakeQueue.activeJobCount).toBe(0);
    expect(compositeBakeQueue.queuedJobCount).toBe(0);
  });

  it("rejects nested content before committing", async () => {
    const nested = content();
    nested.clips = nested.clips.map((clip) => ({
      ...clip,
      compositeId: "nested",
    }));
    await expect(
      useCompositeLibraryStore.getState().createCompositeAsset({ content: nested }),
    ).rejects.toThrow(/cannot contain other composites/i);
    expect(mocks.updateCompositeLibrary).not.toHaveBeenCalled();
  });

  it("places a live-only composite without waiting for a bake", () => {
    const liveOnly = composite({ bakedAssetId: undefined, bake: { status: "queued" } });
    useCompositeLibraryStore.setState({ composites: [liveOnly] });
    const placedId = useCompositeLibraryStore
      .getState()
      .placeCompositeAssetAtTime(liveOnly.id, 100);
    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        id: placedId,
        compositeId: liveOnly.id,
        assetId: `composite-live:${liveOnly.id}`,
        start: 100,
      }),
    ]);
  });

  it("renames, deletes, selects, and reveals composites", async () => {
    const current = composite();
    useCompositeLibraryStore.setState({ composites: [current] });
    await useCompositeLibraryStore
      .getState()
      .renameCompositeAsset(current.id, " Renamed ");
    expect(useCompositeLibraryStore.getState().composites[0].name).toBe("Renamed");

    const state = useCompositeLibraryStore.getState();
    state.selectComposite(current.id);
    state.selectComposite("other", true);
    expect(useCompositeLibraryStore.getState().selectedCompositeIds).toEqual([
      current.id,
      "other",
    ]);
    revealCompositeInBrowser(current.id);
    expect(useCompositeLibraryStore.getState().revealRequest?.compositeAssetId).toBe(
      current.id,
    );
    expect(getCompositeAssets()).toHaveLength(1);
    expect(getCompositeAssetById(current.id)?.name).toBe("Renamed");

    await useCompositeLibraryStore.getState().deleteCompositeAsset(current.id);
    expect(useCompositeLibraryStore.getState().composites).toEqual([]);
  });
});
