import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";

const {
  mockEnsureAssetSourceLoaded,
  mockEnsureBrushBuffer,
  mockGetBrushBuffer,
  mockHydrateBrushBufferFromUrl,
  mockSubscribeToBrushBuffer,
} = vi.hoisted(() => ({
  mockEnsureAssetSourceLoaded: vi.fn(),
  mockEnsureBrushBuffer: vi.fn(),
  mockGetBrushBuffer: vi.fn(() => null),
  mockHydrateBrushBufferFromUrl: vi.fn(async () => undefined),
  mockSubscribeToBrushBuffer: vi.fn(() => () => undefined),
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: mockEnsureAssetSourceLoaded,
}));

vi.mock("../brushBufferRegistry", () => ({
  ensureBrushBuffer: mockEnsureBrushBuffer,
  getBrushBuffer: mockGetBrushBuffer,
  hydrateBrushBufferFromUrl: mockHydrateBrushBufferFromUrl,
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

describe("BrushBufferMaskSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrushBuffer.mockReturnValue(null);
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
    );
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
      .mockReturnValue({
        renderTexture: {} as never,
        canvasSize: { width: 128, height: 72 },
        paintedBounds: null,
        dirty: false,
      });
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
    );
    expect(mockHydrateBrushBufferFromUrl).toHaveBeenNthCalledWith(
      2,
      "clip_1::mask::mask_brush",
      "blob:second-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
    );
  });
});
