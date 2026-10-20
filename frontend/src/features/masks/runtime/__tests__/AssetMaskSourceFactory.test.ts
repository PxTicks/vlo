import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { MaskTimelineClip } from "../../../../types/TimelineTypes";
import type { BrushBuffer } from "../brushBufferRegistry";

const {
  mockGetBrushBuffer,
  mockGetBrushBufferForRenderer,
} = vi.hoisted(() => ({
  mockGetBrushBuffer: vi.fn<() => BrushBuffer | null>(() => null),
  mockGetBrushBufferForRenderer:
    vi.fn<(maskId: string, renderer: Renderer) => BrushBuffer | null>(
      () => null,
    ),
}));

// Only the stateful lookups are stubbed — `hasBrushContent` is a pure
// predicate and stays real so these tests exercise the actual content gate.
vi.mock("../brushBufferRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../brushBufferRegistry")>()),
  getBrushBuffer: mockGetBrushBuffer,
  getBrushBufferForRenderer: mockGetBrushBufferForRenderer,
}));

import { AssetMaskSourceFactory } from "../AssetMaskSourceFactory";
import { ImageMaskSource } from "../ImageMaskSource";
import type { SourceFrameSyncRef } from "../../../renderer/utils/sourceFrameSync";

function createMask(
  maskType: MaskTimelineClip["maskType"],
  overrides: Partial<MaskTimelineClip> = {},
): MaskTimelineClip {
  return {
    id: `clip::mask::${maskType}`,
    trackId: "track",
    type: "mask",
    name: "Mask",
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId: "clip",
    maskType,
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 64, baseHeight: 64 },
    ...overrides,
  };
}

function createImageAsset(id: string): Asset {
  return {
    id,
    type: "image",
    name: `${id}.png`,
    src: `${id}.png`,
    hash: `${id}-hash`,
    createdAt: 0,
  };
}

describe("AssetMaskSourceFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrushBuffer.mockReturnValue(null);
    mockGetBrushBufferForRenderer.mockReturnValue(null);
  });

  it("routes SAM2 PNG masks to immutable image sources", () => {
    const renderer = {} as Renderer;
    const factory = new AssetMaskSourceFactory(renderer);
    const mask = createMask("sam2", {
      sam2MaskAssetId: "sam2-png",
    });

    expect(
      factory.resolveMaskEntry(
        mask,
        new Map([["sam2-png", createImageAsset("sam2-png")]]),
      ),
    ).toEqual({
      maskId: mask.id,
      assetId: "sam2-png",
      kind: "image",
    });
  });

  it("keeps live paint on its owner and gives other renderers the PNG", () => {
    const liveRenderer = {} as Renderer;
    const exportRenderer = {} as Renderer;
    const buffer = {
      renderer: liveRenderer,
      renderTexture: {},
      canvasSize: { width: 64, height: 64 },
      paintedBounds: { x: 2, y: 3, width: 10, height: 12 },
      dirty: true,
      revision: 4,
      sourceAssetId: null,
    } as BrushBuffer;
    mockGetBrushBuffer.mockReturnValue(buffer);
    mockGetBrushBufferForRenderer.mockImplementation(
      (_maskId, renderer) => renderer === liveRenderer ? buffer : null,
    );
    const mask = createMask("brush", {
      brushMaskAssetId: "committed-brush-png",
    });

    expect(
      new AssetMaskSourceFactory(liveRenderer).resolveMaskEntry(mask),
    ).toMatchObject({ kind: "brush" });
    expect(
      new AssetMaskSourceFactory(exportRenderer).resolveMaskEntry(mask),
    ).toEqual({
      maskId: mask.id,
      assetId: "committed-brush-png",
      kind: "image",
    });
  });

  it("stays on the live buffer when its cached bounds are missing", () => {
    // Regression: `kind` is the node identity in `reconcileAssetMaskNodes`, so
    // flipping brush -> image here tore down the live-buffer source and re-read
    // a stale crop from disk. The clip's persisted bounds still prove content.
    const liveRenderer = {} as Renderer;
    const buffer = {
      renderer: liveRenderer,
      renderTexture: {},
      canvasSize: { width: 64, height: 64 },
      paintedBounds: null,
      dirty: false,
      revision: 4,
      sourceAssetId: null,
    } as BrushBuffer;
    mockGetBrushBufferForRenderer.mockReturnValue(buffer);

    const mask = createMask("brush", {
      brushMaskAssetId: "committed-brush-png",
      brushPaintedBounds: { x: 2, y: 3, width: 10, height: 12 },
    });

    expect(
      new AssetMaskSourceFactory(liveRenderer).resolveMaskEntry(mask),
    ).toEqual({
      maskId: mask.id,
      assetId: "committed-brush-png",
      kind: "brush",
    });
  });

  it("produces no entry for a cleared buffer that still has a committed PNG", () => {
    // A cleared buffer supersedes the PNG it came from; falling through to the
    // image source would flash the just-cleared mask back onto the clip.
    const liveRenderer = {} as Renderer;
    mockGetBrushBufferForRenderer.mockReturnValue({
      renderer: liveRenderer,
      renderTexture: {},
      canvasSize: { width: 64, height: 64 },
      paintedBounds: null,
      dirty: true,
      revision: 7,
      sourceAssetId: null,
    } as BrushBuffer);

    expect(
      new AssetMaskSourceFactory(liveRenderer).resolveMaskEntry(
        createMask("brush", {
          brushMaskAssetId: "committed-brush-png",
          brushPaintedBounds: { x: 2, y: 3, width: 10, height: 12 },
        }),
      ),
    ).toBeNull();
  });

  it("produces no entry for a brush mask that has never been painted", () => {
    const liveRenderer = {} as Renderer;
    mockGetBrushBufferForRenderer.mockReturnValue({
      renderer: liveRenderer,
      renderTexture: {},
      canvasSize: { width: 64, height: 64 },
      paintedBounds: null,
      dirty: false,
      revision: 0,
      sourceAssetId: null,
    } as BrushBuffer);

    expect(
      new AssetMaskSourceFactory(liveRenderer).resolveMaskEntry(
        createMask("brush"),
      ),
    ).toBeNull();
  });

  it("decodes each SAM2 asset by the encoding its metadata records", async () => {
    const factory = new AssetMaskSourceFactory({} as Renderer);
    const mask = createMask("sam2", { sam2MaskAssetId: "sam2-png" });
    const { player, decodeFilter } = factory.createMaskSource({
      maskId: mask.id,
      assetId: "sam2-png",
      kind: "image",
    });
    vi.spyOn(player as ImageMaskSource, "setSource").mockResolvedValue();
    vi.spyOn(player as ImageMaskSource, "renderAt").mockResolvedValue();
    const sync = (asset: Asset) =>
      factory.syncMaskNode({ player, assetId: "sam2-png", decodeFilter }, mask, {
        waitForAssetFrame: true,
        skipFrameRender: false,
        sourceFrame: {} as SourceFrameSyncRef,
        parentClipContentSize: { width: 64, height: 64 },
        assetsById: new Map([["sam2-png", asset]]),
        hasUsableTexture: () => true,
      });
    const sam2Metadata = {
      source: "sam2_mask" as const,
      parentAssetId: "parent",
      parentClipId: "clip_1",
      maskClipId: mask.id,
      pointCount: 1,
      sourceHash: "parent-hash",
    };

    await sync({
      ...createImageAsset("sam2-png"),
      creationMetadata: { ...sam2Metadata, maskEncoding: "tsdf8_k8" },
    });
    expect(decodeFilter.encoding).toBe("tsdf8_k8");

    // A regenerated asset from an older backend has no encoding: binary.
    await sync({ ...createImageAsset("sam2-png"), creationMetadata: sam2Metadata });
    expect(decodeFilter.encoding).toBe("binary");
  });

  describe("an image mask whose source fails to load", () => {
    async function syncFailingImageMask(waitForAssetFrame: boolean) {
      const factory = new AssetMaskSourceFactory({} as Renderer);
      const mask = createMask("sam2", { sam2MaskAssetId: "sam2-png" });
      const { player, decodeFilter } = factory.createMaskSource({ maskId: mask.id, assetId: "sam2-png", kind: "image" });
      expect(player).toBeInstanceOf(ImageMaskSource);
      vi.spyOn(player as ImageMaskSource, "setSource").mockRejectedValue(new Error("image gone"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const node = { player, assetId: "sam2-png", decodeFilter };
      const sync = factory.syncMaskNode(node, mask, {
        waitForAssetFrame,
        skipFrameRender: false,
        // Never read: the source fails before any frame is requested.
        sourceFrame: {} as SourceFrameSyncRef,
        parentClipContentSize: { width: 64, height: 64 },
        assetsById: new Map([["sam2-png", createImageAsset("sam2-png")]]),
        hasUsableTexture: () => true,
      });
      return { player, sync };
    }

    it("fails a strict (export) frame rather than rendering the clip unmasked", async () => {
      const { sync } = await syncFailingImageMask(true);
      await expect(sync).rejects.toThrow("image gone");
    });

    it("hides the mask and keeps interactive playback going", async () => {
      const { player, sync } = await syncFailingImageMask(false);
      await expect(sync).resolves.toBeUndefined();
      expect(player.sprite.visible).toBe(false);
    });
  });
});
