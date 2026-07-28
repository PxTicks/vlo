import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createdTextures: [] as Array<{
    options: Record<string, unknown>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  createdGraphics: [] as Array<{
    rect: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    circle: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  createdSprites: [] as Array<{
    texture: unknown;
    position: { set: ReturnType<typeof vi.fn> };
    width: number;
    height: number;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  createdContainers: [] as Array<{
    addChild: ReturnType<typeof vi.fn>;
  }>,
  textureFrom: vi.fn(),
  requestRender: vi.fn(),
}));

vi.mock("pixi.js", () => {
  const RenderTexture = {
    create: vi.fn((options: Record<string, unknown>) => {
      const texture = { options, destroy: vi.fn() };
      mocks.createdTextures.push(texture);
      return texture;
    }),
  };
  const Graphics = vi.fn(function () {
    const graphics = {
      rect: vi.fn(),
      fill: vi.fn(),
      circle: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      destroy: vi.fn(),
    };
    graphics.rect.mockReturnValue(graphics);
    graphics.fill.mockReturnValue(graphics);
    graphics.circle.mockReturnValue(graphics);
    graphics.moveTo.mockReturnValue(graphics);
    graphics.lineTo.mockReturnValue(graphics);
    graphics.stroke.mockReturnValue(graphics);
    mocks.createdGraphics.push(graphics);
    return graphics;
  });
  const Sprite = vi.fn(function (texture: unknown) {
    const sprite = {
      texture,
      position: { set: vi.fn() },
      width: 0,
      height: 0,
      destroy: vi.fn(),
    };
    mocks.createdSprites.push(sprite);
    return sprite;
  });
  const Container = vi.fn(function () {
    const container = { addChild: vi.fn() };
    mocks.createdContainers.push(container);
    return container;
  });
  const Texture = {
    from: mocks.textureFrom,
  };
  return {
    RenderTexture,
    Graphics,
    Sprite,
    Container,
    Texture,
  };
});

vi.mock("../../../../core/liveParams/livePreviewParamStore", () => ({
  livePreviewParamStore: {
    requestRender: mocks.requestRender,
  },
}));

import {
  beginBrushBufferEdit,
  clearBrushBuffer,
  disposeBrushBuffer,
  endBrushBufferEdit,
  ensureBrushBuffer,
  extractBrushPng,
  getBrushBuffer,
  getBrushBufferRevision,
  hydrateBrushBufferFromUrl,
  isBrushBufferDirty,
  isBrushBufferEditing,
  isBrushBufferReadyForSource,
  isBrushBufferRevision,
  markBrushBufferClean,
  paintBrushDot,
  paintBrushStroke,
  recalculateBrushPaintedBounds,
  setBrushPaintedBounds,
  setBrushRenderer,
  subscribeToBrushBuffer,
} from "../brushBufferRegistry";

function renderer(options: {
  canvas?: HTMLCanvasElement | Promise<HTMLCanvasElement>;
  hasExtract?: boolean;
} = {}) {
  return {
    render: vi.fn(),
    extract:
      options.hasExtract === false
        ? undefined
        : {
            canvas: vi.fn(() => options.canvas ?? document.createElement("canvas")),
          },
  };
}

describe("brushBufferRegistry behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createdTextures = [];
    mocks.createdGraphics = [];
    mocks.createdSprites = [];
    mocks.createdContainers = [];
    mocks.textureFrom.mockImplementation(() => ({ destroy: vi.fn() }));
    setBrushRenderer(null);
    for (const id of ["mask", "other", "hydrate", "extract"]) {
      disposeBrushBuffer(id);
    }
  });

  afterEach(() => {
    setBrushRenderer(null);
    vi.unstubAllGlobals();
  });

  it("creates clamped buffers, reuses matching sizes, and replaces resized buffers", () => {
    const first = ensureBrushBuffer("mask", 0.2, 2.6);
    expect(first.canvasSize).toEqual({ width: 1, height: 3 });
    expect(first).toMatchObject({
      paintedBounds: null,
      dirty: false,
      revision: 0,
      sourceAssetId: null,
    });
    expect(ensureBrushBuffer("mask", 1, 3)).toBe(first);

    const second = ensureBrushBuffer("mask", 4, 5);
    expect(second).not.toBe(first);
    expect(first.renderTexture.destroy).toHaveBeenCalledWith(true);
  });

  it("clears new textures when a renderer is connected and notifies subscribers", () => {
    const activeRenderer = renderer();
    setBrushRenderer(activeRenderer as never);
    const listener = vi.fn();
    const unsubscribe = subscribeToBrushBuffer("mask", listener);

    const buffer = ensureBrushBuffer("mask", 10, 10);
    expect(activeRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        target: buffer.renderTexture,
        clear: true,
      }),
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    ensureBrushBuffer("mask", 20, 20);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("paints dots and strokes, expands bounds, and marks revisions dirty", () => {
    const activeRenderer = renderer();
    setBrushRenderer(activeRenderer as never);
    const listener = vi.fn();
    subscribeToBrushBuffer("mask", listener);
    ensureBrushBuffer("mask", 100, 80);
    listener.mockClear();

    paintBrushDot("mask", 5, 6, 0, "paint");
    expect(getBrushBuffer("mask")).toMatchObject({
      paintedBounds: { x: 4, y: 5, width: 2, height: 2 },
      dirty: true,
      revision: 1,
      sourceAssetId: null,
    });
    expect(mocks.createdGraphics.at(-1)?.circle).toHaveBeenCalledWith(
      5,
      6,
      0.5,
    );

    paintBrushStroke("mask", 10, 20, 30, 40, 3, "erase");
    expect(getBrushBuffer("mask")?.paintedBounds).toEqual({
      x: 4,
      y: 5,
      width: 29,
      height: 38,
    });
    expect(getBrushBufferRevision("mask")).toBe(2);
    expect(isBrushBufferDirty("mask")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(mocks.requestRender).toHaveBeenCalledTimes(2);
    expect(activeRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ clear: false }),
    );
  });

  it("ignores paint and clear requests for missing buffers", () => {
    paintBrushDot("missing", 0, 0, 1, "paint");
    paintBrushStroke("missing", 0, 0, 1, 1, 1, "paint");
    clearBrushBuffer("missing");
    expect(mocks.requestRender).not.toHaveBeenCalled();
  });

  it("clears, marks clean, and validates source readiness", () => {
    const activeRenderer = renderer();
    setBrushRenderer(activeRenderer as never);
    ensureBrushBuffer("mask", 10, 20);
    paintBrushDot("mask", 2, 3, 1, "paint");
    const revision = getBrushBufferRevision("mask");
    expect(isBrushBufferRevision("mask", revision)).toBe(true);
    expect(isBrushBufferRevision("mask", null)).toBe(false);
    expect(isBrushBufferRevision("missing", 0)).toBe(false);

    markBrushBufferClean("mask", "asset-1");
    const bounds = getBrushBuffer("mask")?.paintedBounds ?? null;
    expect(
      isBrushBufferReadyForSource("mask", "asset-1", 10, 20, bounds),
    ).toBe(true);
    expect(
      isBrushBufferReadyForSource("mask", "asset-2", 10, 20, bounds),
    ).toBe(false);
    expect(
      isBrushBufferReadyForSource("mask", "asset-1", 11, 20, bounds),
    ).toBe(false);

    clearBrushBuffer("mask");
    expect(getBrushBuffer("mask")).toMatchObject({
      paintedBounds: null,
      dirty: true,
      sourceAssetId: null,
    });
  });

  it("sets bounds, tracks edit sessions, and disposes resources", () => {
    const listener = vi.fn();
    subscribeToBrushBuffer("mask", listener);
    const buffer = ensureBrushBuffer("mask", 10, 10);
    setBrushPaintedBounds("mask", { x: 1, y: 2, width: 3, height: 4 });
    expect(buffer.paintedBounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    setBrushPaintedBounds("missing", null);

    beginBrushBufferEdit("mask");
    beginBrushBufferEdit("mask");
    expect(isBrushBufferEditing("mask")).toBe(true);
    endBrushBufferEdit("mask");
    expect(isBrushBufferEditing("mask")).toBe(true);
    disposeBrushBuffer("mask");
    expect(buffer.renderTexture.destroy).toHaveBeenCalledWith(true);
    expect(getBrushBuffer("mask")).toBeNull();
    expect(isBrushBufferEditing("mask")).toBe(false);
    disposeBrushBuffer("mask");
  });

  it("recalculates painted bounds from extracted canvas pixels", async () => {
    const canvas = document.createElement("canvas");
    const getImageData = vi.fn(() => ({
      data: new Uint8ClampedArray([
        0, 0, 0, 255,
        1, 0, 0, 255,
        0, 0, 0, 255,
        0, 0, 0, 255,
      ]),
    }));
    vi.spyOn(canvas, "getContext").mockReturnValue({
      getImageData,
    } as never);
    const activeRenderer = renderer({ canvas: Promise.resolve(canvas) });
    setBrushRenderer(activeRenderer as never);
    ensureBrushBuffer("mask", 2, 2);
    const listener = vi.fn();
    subscribeToBrushBuffer("mask", listener);

    await expect(recalculateBrushPaintedBounds("mask")).resolves.toEqual({
      x: 1,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 2);
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    await recalculateBrushPaintedBounds("mask");
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back when bounds extraction is unavailable", async () => {
    const buffer = ensureBrushBuffer("mask", 2, 2);
    buffer.paintedBounds = { x: 0, y: 0, width: 1, height: 1 };
    await expect(recalculateBrushPaintedBounds("mask")).resolves.toEqual(
      buffer.paintedBounds,
    );
    setBrushRenderer(renderer({ hasExtract: false }) as never);
    await expect(recalculateBrushPaintedBounds("mask")).resolves.toEqual(
      buffer.paintedBounds,
    );
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    setBrushRenderer(renderer({ canvas }) as never);
    await expect(recalculateBrushPaintedBounds("mask")).resolves.toEqual(
      buffer.paintedBounds,
    );
  });

  it("extracts cropped PNG blobs and destroys temporary textures", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) =>
        callback(new Blob(["png"], { type: "image/png" })),
    });
    const activeRenderer = renderer({ canvas });
    setBrushRenderer(activeRenderer as never);
    const buffer = ensureBrushBuffer("extract", 20, 10);
    buffer.paintedBounds = { x: 2, y: 3, width: 4.2, height: 5.1 };

    await expect(extractBrushPng("extract")).resolves.toBeInstanceOf(Blob);
    const cropped = mocks.createdTextures.at(-1)!;
    expect(cropped.options).toEqual({ width: 5, height: 6 });
    expect(mocks.createdSprites.at(-1)?.position.set).toHaveBeenCalledWith(
      -2,
      -3,
    );
    expect(cropped.destroy).toHaveBeenCalledWith(true);
  });

  it("returns null for unavailable or empty PNG extraction", async () => {
    expect(await extractBrushPng("missing")).toBeNull();
    const buffer = ensureBrushBuffer("extract", 10, 10);
    expect(await extractBrushPng("extract")).toBeNull();
    setBrushRenderer(renderer({ hasExtract: false }) as never);
    expect(
      await extractBrushPng("extract", { x: 0, y: 0, width: 0, height: 1 }),
    ).toBeNull();
    buffer.paintedBounds = null;
    expect(await extractBrushPng("extract")).toBeNull();
  });

  it("retries PNG hydration after the renderer becomes available", async () => {
    const listener = vi.fn();
    subscribeToBrushBuffer("hydrate", listener);
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    const buffer = await hydrateBrushBufferFromUrl(
      "hydrate",
      "blob:mask",
      10,
      20,
      bounds,
      "asset-1",
    );
    expect(buffer).toMatchObject({
      paintedBounds: null,
      dirty: false,
      sourceAssetId: null,
    });
    expect(
      isBrushBufferReadyForSource(
        "hydrate",
        "asset-1",
        10,
        20,
        bounds,
      ),
    ).toBe(false);
    // Buffer creation notifies once, but the unavailable-renderer branch must
    // not publish a false "hydrated" state.
    expect(listener).toHaveBeenCalledTimes(1);

    const activeRenderer = renderer();
    setBrushRenderer(activeRenderer as never);
    class ImageMock {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    vi.stubGlobal("Image", ImageMock);

    await hydrateBrushBufferFromUrl(
      "hydrate",
      "blob:mask",
      10,
      20,
      bounds,
      "asset-1",
    );
    expect(mocks.textureFrom).toHaveBeenCalled();
    expect(activeRenderer.render).toHaveBeenCalled();
    expect(buffer).toMatchObject({
      paintedBounds: bounds,
      dirty: false,
      sourceAssetId: "asset-1",
    });
    expect(listener).toHaveBeenCalledTimes(2);

    mocks.textureFrom.mockClear();
    buffer.dirty = true;
    await hydrateBrushBufferFromUrl(
      "hydrate",
      "blob:new",
      10,
      20,
      bounds,
      "asset-2",
    );
    expect(mocks.textureFrom).not.toHaveBeenCalled();
  });

  it("loads and positions hydrated PNG textures", async () => {
    const activeRenderer = renderer();
    setBrushRenderer(activeRenderer as never);
    class ImageMock {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    vi.stubGlobal("Image", ImageMock);
    const texture = { destroy: vi.fn() };
    mocks.textureFrom.mockReturnValue(texture);
    const bounds = { x: 2, y: 3, width: 4, height: 5 };

    const buffer = await hydrateBrushBufferFromUrl(
      "hydrate",
      "blob:mask",
      20,
      10,
      bounds,
      "asset-1",
    );

    const sprite = mocks.createdSprites.at(-1)!;
    expect(sprite.position.set).toHaveBeenCalledWith(2, 3);
    expect(sprite.width).toBe(4);
    expect(sprite.height).toBe(5);
    expect(mocks.createdContainers.at(-1)?.addChild).toHaveBeenCalledTimes(2);
    expect(activeRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ target: buffer.renderTexture, clear: true }),
    );
    expect(texture.destroy).toHaveBeenCalledWith(true);
    expect(buffer).toMatchObject({
      dirty: false,
      revision: 1,
      sourceAssetId: "asset-1",
    });
  });

  it("rejects failed hydration image loads", async () => {
    setBrushRenderer(renderer() as never);
    class ImageMock {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onerror?.();
      }
    }
    vi.stubGlobal("Image", ImageMock);

    await expect(
      hydrateBrushBufferFromUrl(
        "hydrate",
        "blob:bad",
        10,
        10,
        null,
        "asset-new",
      ),
    ).rejects.toThrow("Failed to load brush PNG");
  });
});
