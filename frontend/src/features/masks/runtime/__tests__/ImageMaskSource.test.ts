import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";

const mocks = vi.hoisted(() => ({
  ensureAssetSourceLoaded: vi.fn(),
  textureFrom: vi.fn(),
  emptyTexture: { destroyed: false },
}));

vi.mock("pixi.js", () => {
  class Sprite {
    public texture = mocks.emptyTexture;
    public visible = false;
    public destroyed = false;
    public width = 0;
    public height = 0;
    public readonly anchor = { set: vi.fn() };

    public destroy(): void {
      this.destroyed = true;
    }
  }

  return {
    Sprite,
    Texture: {
      EMPTY: mocks.emptyTexture,
      from: mocks.textureFrom,
    },
  };
});

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: mocks.ensureAssetSourceLoaded,
}));

import { ImageMaskSource } from "../ImageMaskSource";

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "mask-image",
    type: "image",
    name: "mask.png",
    src: "asset:mask.png",
    hash: "mask-hash",
    createdAt: 0,
    ...overrides,
  };
}

describe("ImageMaskSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAssetSourceLoaded.mockResolvedValue(null);
    mocks.textureFrom.mockReturnValue({
      width: 64,
      height: 32,
      destroyed: false,
      destroy: vi.fn(),
    });

    class ImageMock {
      public crossOrigin = "";
      public naturalWidth = 64;
      public naturalHeight = 32;
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      public set src(_value: string) {
        this.onload?.();
      }
    }
    vi.stubGlobal("Image", ImageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps immutable image pixels as the texture source", async () => {
    const onFrameReady = vi.fn();
    const source = new ImageMaskSource(onFrameReady);
    const hydrated = createAsset({ src: "blob:hydrated-mask" });
    mocks.ensureAssetSourceLoaded.mockResolvedValue(hydrated);

    await source.setSource(createAsset());

    expect(mocks.ensureAssetSourceLoaded).toHaveBeenCalledWith("mask-image");
    expect(mocks.textureFrom).toHaveBeenCalledWith(
      expect.objectContaining({
        crossOrigin: "anonymous",
        naturalWidth: 64,
        naturalHeight: 32,
      }),
    );
    expect(source.sprite).toMatchObject({
      visible: true,
      width: 64,
      height: 32,
    });
    expect(source.hasFrame()).toBe(true);
    expect(onFrameReady).toHaveBeenCalledOnce();
  });

  it("coalesces repeated source syncs while the image is loading", async () => {
    let resolveHydration: ((asset: Asset) => void) | undefined;
    mocks.ensureAssetSourceLoaded.mockReturnValue(
      new Promise<Asset>((resolve) => {
        resolveHydration = resolve;
      }),
    );
    const source = new ImageMaskSource();
    const asset = createAsset();

    const firstLoad = source.setSource(asset);
    const repeatedLoad = source.setSource(asset);

    expect(mocks.ensureAssetSourceLoaded).toHaveBeenCalledOnce();
    resolveHydration?.(createAsset({ src: "blob:hydrated-mask" }));
    await Promise.all([firstLoad, repeatedLoad]);

    expect(mocks.textureFrom).toHaveBeenCalledOnce();
    expect(source.hasFrame()).toBe(true);
  });

  it("restores sprite visibility when an existing source becomes active again", async () => {
    const source = new ImageMaskSource();
    const asset = createAsset();
    await source.setSource(asset);
    source.sprite.visible = false;

    await source.setSource(asset);

    expect(source.sprite.visible).toBe(true);
    expect(mocks.ensureAssetSourceLoaded).toHaveBeenCalledOnce();
    expect(mocks.textureFrom).toHaveBeenCalledOnce();
  });

  it("reconstructs cropped brush PNGs in canvas coordinates", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage,
      fillRect,
      fillStyle: "",
    } as never);
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return canvas;
        }
        return originalCreateElement(tagName);
      });
    const source = new ImageMaskSource();
    source.setGeometryContext({
      canvasWidth: 128,
      canvasHeight: 72,
      imageBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    await source.setSource(createAsset());

    expect(canvas.width).toBe(128);
    expect(canvas.height).toBe(72);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 128, 72);
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      10,
      12,
      30,
      20,
    );
    expect(mocks.textureFrom).toHaveBeenCalledWith(canvas);
    expect(source.sprite).toMatchObject({
      width: 128,
      height: 72,
      visible: true,
    });
    createElement.mockRestore();
  });

  it("destroys only its owned image texture on disposal", async () => {
    const texture = {
      width: 10,
      height: 10,
      destroyed: false,
      destroy: vi.fn(),
    };
    mocks.textureFrom.mockReturnValue(texture);
    const source = new ImageMaskSource();

    await source.setSource(createAsset());
    source.dispose();

    expect(texture.destroy).toHaveBeenCalledWith(true);
    expect(source.sprite.destroyed).toBe(true);
    expect(source.hasFrame()).toBe(false);
  });

  it("fails closed while replacing an image mask", async () => {
    const oldTexture = {
      width: 10,
      height: 10,
      destroyed: false,
      destroy: vi.fn(),
    };
    mocks.textureFrom.mockReturnValue(oldTexture);
    const source = new ImageMaskSource();
    await source.setSource(createAsset());

    class FailedImageMock {
      public crossOrigin = "";
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      public set src(_value: string) {
        this.onerror?.();
      }
    }
    vi.stubGlobal("Image", FailedImageMock);

    await expect(
      source.setSource(createAsset({ id: "replacement-mask" })),
    ).rejects.toThrow("Failed to load image mask");
    expect(oldTexture.destroy).toHaveBeenCalledWith(true);
    expect(source.hasFrame()).toBe(false);
  });
});
