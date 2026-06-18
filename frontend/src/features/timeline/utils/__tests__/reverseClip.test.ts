import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";

// --- Mocked dependencies ------------------------------------------------------
vi.mock("../../../userAssets/api", () => ({
  getAssets: vi.fn(() => []),
  ensureAssetSourceLoaded: vi.fn(),
}));
vi.mock("../../../userAssets/useAssetStore", () => ({
  useAssetStore: { getState: vi.fn() },
}));
vi.mock("../../../userAssets/services/AssetReversalService", () => ({
  reverseAssetFile: vi.fn(),
}));
vi.mock("../../../transformations/utils/reverseTransformations", () => ({
  reverseTransformationStack: vi.fn((stack: unknown) => stack),
}));
vi.mock("../../../masks/utils/reverseMask", () => ({
  reverseMaskTimelineClip: vi.fn((mask: Record<string, unknown>) => ({
    maskPoints: mask.maskPoints ?? [],
    activeRange: mask.activeRange ?? null,
    sam2GeneratedPointsHash: null,
    sam2MaskAssetId: null,
    sam2LastGeneratedAt: null,
  })),
}));
vi.mock("../../model/maskClipModel", () => ({
  getOrderedChildMaskClips: vi.fn(() => []),
  parseMaskClipId: vi.fn(),
}));
vi.mock("../../useTimelineStore", () => ({
  useTimelineStore: { getState: vi.fn() },
}));
vi.mock("../../hooks/useClipReversalStore", () => ({
  beginClipReversal: vi.fn(),
  endClipReversal: vi.fn(),
}));

import { ensureAssetSourceLoaded, getAssets } from "../../../userAssets/api";
import { useAssetStore } from "../../../userAssets/useAssetStore";
import { reverseAssetFile } from "../../../userAssets/services/AssetReversalService";
import {
  getOrderedChildMaskClips,
  parseMaskClipId,
} from "../../model/maskClipModel";
import { useTimelineStore } from "../../useTimelineStore";
import {
  beginClipReversal,
  endClipReversal,
} from "../../hooks/useClipReversalStore";
import { ClipReversalError, reverseTimelineClip } from "../reverseClip";

// --- Builders -----------------------------------------------------------------
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    name: "clip.mp4",
    creationMetadata: undefined,
    ...overrides,
  } as unknown as Asset;
}

function makeClip(overrides: Record<string, unknown> = {}) {
  return {
    id: "clip-1",
    type: "video",
    assetId: "asset-1",
    sourceDuration: 1000,
    offset: 100,
    croppedSourceDuration: 600,
    transformedDuration: 1000,
    transformedOffset: 50,
    timelineDuration: 700,
    transformations: [],
    components: [],
    ...overrides,
  };
}

interface StoreStub {
  clips: unknown[];
  replaceClipAsset: ReturnType<typeof vi.fn>;
  updateClipShape: ReturnType<typeof vi.fn>;
  setClipTransforms: ReturnType<typeof vi.fn>;
  updateClipComponent: ReturnType<typeof vi.fn>;
  updateClipMask: ReturnType<typeof vi.fn>;
}

function installStore(clips: unknown[]): StoreStub {
  const store: StoreStub = {
    clips,
    replaceClipAsset: vi.fn(),
    updateClipShape: vi.fn(),
    setClipTransforms: vi.fn(),
    updateClipComponent: vi.fn(),
    updateClipMask: vi.fn(),
  };
  vi.mocked(useTimelineStore.getState).mockReturnValue(store as never);
  return store;
}

const addLocalAsset = vi.fn();

beforeEach(() => {
  vi.mocked(getAssets).mockReturnValue([]);
  vi.mocked(getOrderedChildMaskClips).mockReturnValue([]);
  vi.mocked(parseMaskClipId).mockReset();
  addLocalAsset.mockReset();
  vi.mocked(useAssetStore.getState).mockReturnValue({ addLocalAsset } as never);
  vi.mocked(reverseAssetFile).mockReset();
  vi.mocked(ensureAssetSourceLoaded).mockReset();
  vi.mocked(beginClipReversal).mockClear();
  vi.mocked(endClipReversal).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("reverseTimelineClip guard clauses", () => {
  it("throws when the clip is missing", async () => {
    installStore([]);
    await expect(reverseTimelineClip("nope")).rejects.toBeInstanceOf(
      ClipReversalError,
    );
  });

  it("throws for non asset-backed clips", async () => {
    installStore([makeClip({ id: "t", type: "text" })]);
    await expect(reverseTimelineClip("t")).rejects.toThrow(
      /video\/audio clips/,
    );
  });

  it("throws for clips without a finite source duration", async () => {
    installStore([makeClip({ id: "img", type: "image", sourceDuration: 0 })]);
    await expect(reverseTimelineClip("img")).rejects.toThrow(
      /no finite source duration/,
    );
  });

  it("throws when the source asset is absent from the store", async () => {
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([]);
    await expect(reverseTimelineClip("clip-1")).rejects.toThrow(
      /source asset is missing/,
    );
  });
});

describe("reverseTimelineClip fresh encode", () => {
  it("encodes, ingests, and applies all store mutations", async () => {
    const sourceAsset = makeAsset();
    const reversedAsset = makeAsset({ id: "asset-rev", name: "clip-rev.mp4" });
    const markerClip = makeClip({
      components: [
        {
          id: "comp-1",
          type: "markers",
          parameters: { markers: [{ sourceTimeTicks: 100 }, { sourceTimeTicks: 900 }] },
        },
      ],
    });
    const store = installStore([markerClip]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({
      file: new File(["x"], "clip.mp4"),
    } as never);
    vi.mocked(reverseAssetFile).mockResolvedValue({
      file: new File(["y"], "rev.mp4"),
    } as never);
    addLocalAsset.mockResolvedValue(reversedAsset);

    const result = await reverseTimelineClip("clip-1");

    expect(result).toBe(reversedAsset);
    expect(beginClipReversal).toHaveBeenCalledWith("clip-1");
    expect(endClipReversal).toHaveBeenCalledWith("clip-1");
    expect(reverseAssetFile).toHaveBeenCalledOnce();
    expect(store.replaceClipAsset).toHaveBeenCalledWith("clip-1", reversedAsset);
    expect(store.updateClipShape).toHaveBeenCalledWith("clip-1", {
      offset: 300, // 1000 - 100 - 600
      transformedOffset: 250, // 1000 - 50 - 700
    });
    expect(store.setClipTransforms).toHaveBeenCalledOnce();
    // markers component mirrored and re-sorted ascending
    expect(store.updateClipComponent).toHaveBeenCalledWith(
      "clip-1",
      "comp-1",
      expect.any(Function),
    );
    const producedComponent = store.updateClipComponent.mock.calls[0][2]();
    expect(producedComponent.parameters.markers.map((m: { sourceTimeTicks: number }) => m.sourceTimeTicks)).toEqual([100, 900]);
  });

  it("reverses child mask clips that resolve to the parent", async () => {
    const sourceAsset = makeAsset();
    const store = installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({
      file: new File(["x"], "clip.mp4"),
    } as never);
    vi.mocked(reverseAssetFile).mockResolvedValue({
      file: new File(["y"], "rev.mp4"),
    } as never);
    addLocalAsset.mockResolvedValue(makeAsset({ id: "asset-rev" }));
    vi.mocked(getOrderedChildMaskClips).mockReturnValue([
      { id: "clip-1::mask::m1", transformations: [], maskPoints: [] },
    ] as never);
    vi.mocked(parseMaskClipId).mockReturnValue({
      clipId: "clip-1",
      maskId: "m1",
    } as never);

    await reverseTimelineClip("clip-1");

    expect(store.updateClipMask).toHaveBeenCalledWith(
      "clip-1",
      "m1",
      expect.objectContaining({ activeRange: null }),
    );
  });

  it("skips masks whose id does not parse to the parent clip", async () => {
    const sourceAsset = makeAsset();
    const store = installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({
      file: new File(["x"], "clip.mp4"),
    } as never);
    vi.mocked(reverseAssetFile).mockResolvedValue({
      file: new File(["y"], "rev.mp4"),
    } as never);
    addLocalAsset.mockResolvedValue(makeAsset({ id: "asset-rev" }));
    vi.mocked(getOrderedChildMaskClips).mockReturnValue([
      { id: "other::mask::m1", transformations: [], maskPoints: [] },
    ] as never);
    vi.mocked(parseMaskClipId).mockReturnValue(null as never);

    await reverseTimelineClip("clip-1");
    expect(store.updateClipMask).not.toHaveBeenCalled();
  });
});

describe("reverseTimelineClip fast paths", () => {
  it("round-trips a reversed clip back to its still-present original", async () => {
    const original = makeAsset({ id: "orig" });
    const reversedSource = makeAsset({
      id: "asset-1",
      creationMetadata: { source: "reversed", sourceAssetId: "orig" } as never,
    });
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([reversedSource, original]);

    const result = await reverseTimelineClip("clip-1");

    expect(result).toBe(original);
    expect(reverseAssetFile).not.toHaveBeenCalled();
    expect(ensureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(endClipReversal).toHaveBeenCalledWith("clip-1");
  });

  it("reuses an already-encoded reversed twin", async () => {
    const sourceAsset = makeAsset();
    const cachedTwin = makeAsset({
      id: "twin",
      creationMetadata: { source: "reversed", sourceAssetId: "asset-1" } as never,
    });
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset, cachedTwin]);

    const result = await reverseTimelineClip("clip-1");

    expect(result).toBe(cachedTwin);
    expect(reverseAssetFile).not.toHaveBeenCalled();
  });

  it("forces a fresh encode when reuse is disabled", async () => {
    const sourceAsset = makeAsset();
    const cachedTwin = makeAsset({
      id: "twin",
      creationMetadata: { source: "reversed", sourceAssetId: "asset-1" } as never,
    });
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset, cachedTwin]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({
      file: new File(["x"], "clip.mp4"),
    } as never);
    vi.mocked(reverseAssetFile).mockResolvedValue({
      file: new File(["y"], "rev.mp4"),
    } as never);
    addLocalAsset.mockResolvedValue(makeAsset({ id: "fresh" }));

    await reverseTimelineClip("clip-1", { reuseExistingReversedAsset: false });
    expect(reverseAssetFile).toHaveBeenCalledOnce();
  });
});

describe("reverseTimelineClip failure paths", () => {
  it("throws when the source file cannot be hydrated", async () => {
    const sourceAsset = makeAsset();
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({ file: null } as never);

    await expect(reverseTimelineClip("clip-1")).rejects.toThrow(
      /Source file is not available/,
    );
    expect(endClipReversal).toHaveBeenCalledWith("clip-1");
  });

  it("throws when the reversed asset fails to ingest", async () => {
    const sourceAsset = makeAsset();
    installStore([makeClip()]);
    vi.mocked(getAssets).mockReturnValue([sourceAsset]);
    vi.mocked(ensureAssetSourceLoaded).mockResolvedValue({
      file: new File(["x"], "clip.mp4"),
    } as never);
    vi.mocked(reverseAssetFile).mockResolvedValue({
      file: new File(["y"], "rev.mp4"),
    } as never);
    addLocalAsset.mockResolvedValue(null);

    await expect(reverseTimelineClip("clip-1")).rejects.toThrow(
      /Failed to ingest/,
    );
  });
});
