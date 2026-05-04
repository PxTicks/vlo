import { beforeEach, describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { BrushBuffer } from "../brushBufferRegistry";

const {
  mockEnsureAssetSourceLoaded,
  mockEnsureBrushBuffer,
  mockGetBrushBuffer,
  mockHydrateBrushBufferFromUrl,
  mockIsBrushBufferReadyForSource,
  mockSubscribeToBrushBuffer,
} = vi.hoisted(() => ({
  mockEnsureAssetSourceLoaded: vi.fn(),
  mockEnsureBrushBuffer: vi.fn(),
  mockGetBrushBuffer: vi.fn<() => BrushBuffer | null>(() => null),
  mockHydrateBrushBufferFromUrl: vi.fn(async () => undefined),
  mockIsBrushBufferReadyForSource: vi.fn(() => false),
  mockSubscribeToBrushBuffer: vi.fn(() => () => undefined),
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: mockEnsureAssetSourceLoaded,
}));

vi.mock("../brushBufferRegistry", () => ({
  ensureBrushBuffer: mockEnsureBrushBuffer,
  getBrushBuffer: mockGetBrushBuffer,
  hydrateBrushBufferFromUrl: mockHydrateBrushBufferFromUrl,
  isBrushBufferReadyForSource: mockIsBrushBufferReadyForSource,
  subscribeToBrushBuffer: mockSubscribeToBrushBuffer,
}));

import { BrushBufferMaskSource } from "../BrushBufferMaskSource";

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "brush-asset-1",
    type: "image",
    name: "brush.png",
    src: "assets/brush.png",
    hash: "brush-hash",
    createdAt: 0,
    ...overrides,
  };
}

function createBrushBuffer(
  overrides: Partial<BrushBuffer> = {},
): BrushBuffer {
  return {
    renderTexture: Texture.EMPTY as never,
    canvasSize: { width: 128, height: 72 },
    paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    dirty: false,
    sourceAssetId: null,
    ...overrides,
  };
}

describe("BrushBufferMaskSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrushBuffer.mockReturnValue(null);
    mockIsBrushBufferReadyForSource.mockReturnValue(false);
    mockEnsureAssetSourceLoaded.mockResolvedValue(null);
  });

  it("hydrates using the resolved asset source url", async () => {
    const source = new BrushBufferMaskSource("clip_1::mask::mask_brush");
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    mockEnsureAssetSourceLoaded.mockResolvedValue(
      createAsset({ src: "blob:hydrated-brush-url" }),
    );

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).toHaveBeenCalledWith("brush-asset-1");
    expect(mockHydrateBrushBufferFromUrl).toHaveBeenCalledWith(
      "clip_1::mask::mask_brush",
      "blob:hydrated-brush-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      "brush-asset-1",
    );
  });

  it("falls back to the passed asset when source hydration returns null", async () => {
    const source = new BrushBufferMaskSource("clip_1::mask::mask_brush");
    source.setHydrationContext({
      canvasWidth: 64,
      canvasHeight: 64,
      paintedBounds: null,
    });

    await source.setSource(createAsset({ src: "blob:existing-brush-url" }));

    expect(mockHydrateBrushBufferFromUrl).toHaveBeenCalledWith(
      "clip_1::mask::mask_brush",
      "blob:existing-brush-url",
      64,
      64,
      null,
      "brush-asset-1",
    );
  });

  it("does not hydrate over a dirty live buffer", async () => {
    const source = new BrushBufferMaskSource("clip_1::mask::mask_brush");
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        dirty: true,
        sourceAssetId: null,
      }),
    );

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("reuses a clean live buffer already committed to the same asset", async () => {
    const source = new BrushBufferMaskSource("clip_1::mask::mask_brush");
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        sourceAssetId: "brush-asset-1",
      }),
    );
    mockIsBrushBufferReadyForSource.mockReturnValue(true);

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("retries hydration when an earlier attempt left behind an empty buffer", async () => {
    const source = new BrushBufferMaskSource("clip_1::mask::mask_brush");
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    mockGetBrushBuffer
      .mockReturnValueOnce(null)
      .mockReturnValue(createBrushBuffer({
        canvasSize: { width: 128, height: 72 },
        paintedBounds: null,
        dirty: false,
      }));
    mockEnsureAssetSourceLoaded
      .mockResolvedValueOnce(createAsset({ src: "blob:first-url" }))
      .mockResolvedValueOnce(createAsset({ src: "blob:second-url" }));
    mockHydrateBrushBufferFromUrl
      .mockRejectedValueOnce(new Error("first hydration failed"))
      .mockResolvedValueOnce(undefined);

    await source.setSource(createAsset());
    await source.setSource(createAsset());

    expect(mockHydrateBrushBufferFromUrl).toHaveBeenNthCalledWith(
      1,
      "clip_1::mask::mask_brush",
      "blob:first-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      "brush-asset-1",
    );
    expect(mockHydrateBrushBufferFromUrl).toHaveBeenNthCalledWith(
      2,
      "clip_1::mask::mask_brush",
      "blob:second-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      "brush-asset-1",
    );
  });
});
