import { describe, expect, it, vi } from "vitest";
import { AlphaMask, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";

vi.mock("../MaskVideoFramePlayer", async () => {
  const { Sprite, Texture } = await import("pixi.js");

  class MockMaskVideoFramePlayer {
    public readonly sprite: Sprite;
    public readonly setSource = vi.fn(async () => undefined);
    public readonly renderAt = vi.fn(async () => undefined);
    public readonly dispose = vi.fn(() => undefined);

    constructor(...args: [string]) {
      void args;
      this.sprite = new Sprite(Texture.WHITE);
      this.sprite.anchor.set(0.5);
      this.sprite.visible = true;
    }
  }

  return {
    MaskVideoFramePlayer: MockMaskVideoFramePlayer,
  };
});

import { SpriteClipMaskController } from "../SpriteClipMaskController";

function createParentClip(): TimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video",
    name: "Parent clip",
    assetId: "asset_1",
    sourceDuration: 500,
    start: 0,
    timelineDuration: 500,
    offset: 0,
    transformedDuration: 500,
    transformedOffset: 0,
    croppedSourceDuration: 500,
    transformations: [],
  };
}

function createMaskClip(
  localId: string,
  options: {
    inverted?: boolean;
    maskType?: MaskTimelineClip["maskType"];
    sam2MaskAssetId?: string;
    generationMaskAssetId?: string;
    transformations?: MaskTimelineClip["transformations"];
  } = {},
): MaskTimelineClip {
  return {
    id: `clip_1::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: localId,
    sourceDuration: 500,
    start: 0,
    timelineDuration: 500,
    offset: 0,
    transformedDuration: 500,
    transformedOffset: 0,
    croppedSourceDuration: 500,
    transformations: options.transformations ?? [],
    parentClipId: "clip_1",
    maskType: options.maskType ?? "rectangle",
    maskMode: "apply",
    maskInverted: options.inverted ?? false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    sam2MaskAssetId: options.sam2MaskAssetId,
    generationMaskAssetId: options.generationMaskAssetId,
  };
}

function createMaskAsset(id: string): Asset {
  return {
    id,
    type: "video",
    name: `${id}.webm`,
    src: `${id}.webm`,
    hash: `${id}-hash`,
    createdAt: 0,
  };
}

describe("SpriteClipMaskController mask composition", () => {
  it("rasterizes vector masks with edge transforms into sprite-backed nodes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const featheredMask = createMaskClip("mask_feathered", {
      transformations: [
        {
          id: "feather_1",
          type: "feather",
          isEnabled: true,
          parameters: {
            mode: "soft_inner",
            amount: 20,
          },
        },
      ],
    });

    await controller.syncMaskClips(
      [featheredMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (root.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;
    const node = (
      controller as unknown as {
        vectorMaskNodes: Map<
          string,
          {
            presentation: "graphics" | "sprite";
            graphics: Graphics;
            spriteHost: Container;
            sprite: Sprite;
          }
        >;
      }
    ).vectorMaskNodes.get(featheredMask.id);

    expect(alphaMaskEffect).not.toBeNull();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(node?.presentation).toBe("sprite");
    expect(node?.graphics.visible).toBe(false);
    expect(node?.spriteHost.visible).toBe(true);
    expect(node?.sprite.visible).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("uses AlphaMask.inverse for a single inverted mask", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const invertedMask = createMaskClip("mask_inverted_single", {
      inverted: true,
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [invertedMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (root.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(alphaMaskEffect?.inverse).toBe(true);
    // Single-mask path renders only the full mask texture (no per-mask erase pass).
    expect(renderSpy).toHaveBeenCalledTimes(1);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("composites inverted masks per mask and keeps AlphaMask.inverse false", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const normalMask = createMaskClip("mask_normal", { inverted: false });
    const invertedMask = createMaskClip("mask_inverted", {
      inverted: true,
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [normalMask, invertedMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (root.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(alphaMaskEffect?.inverse).toBe(false);

    // Non-inverted union + inverted union + erase compositing pass.
    expect(renderSpy).toHaveBeenCalledTimes(3);

    const compositingCall = renderSnapshots.find((call) => {
      return (
        call.clear === false &&
        call.transform === undefined &&
        call.blendMode === "multiply"
      );
    });
    expect(compositingCall).toBeTruthy();

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("renders multiple inverted masks as one erased union pass", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const invertedMaskA = createMaskClip("mask_inv_a", {
      inverted: true,
      maskType: "rectangle",
    });
    const invertedMaskB = createMaskClip("mask_inv_b", {
      inverted: true,
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [invertedMaskA, invertedMaskB],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    // Fill full mask + render inverted union + erase union.
    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(
      renderSnapshots.filter((call) => call.transform !== undefined).length,
    ).toBe(1);
    expect(
      renderSnapshots.some(
        (call) =>
          call.clear === false &&
          call.transform === undefined &&
          call.blendMode === "multiply",
      ),
    ).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("renders generation masks through the asset-backed mask video path", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const generationMask = createMaskClip("mask_generation", {
      maskType: "generation",
      generationMaskAssetId: "generation-mask-asset",
    });
    const generationAsset = createMaskAsset("generation-mask-asset");

    await controller.syncMaskClips(
      [generationMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[generationAsset.id, generationAsset]]),
      { waitForSam2: true },
    );

    const alphaMaskEffect = (root.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;
    const node = (
      controller as unknown as {
        assetMaskNodes: Map<
          string,
          {
            player: {
              setSource: ReturnType<typeof vi.fn>;
              renderAt: ReturnType<typeof vi.fn>;
            };
          }
        >;
        vectorMaskNodes: Map<string, unknown>;
      }
    );

    expect(alphaMaskEffect).not.toBeNull();
    expect(node.assetMaskNodes.has(generationMask.id)).toBe(true);
    expect(node.vectorMaskNodes.has(generationMask.id)).toBe(false);
    expect(
      node.assetMaskNodes.get(generationMask.id)?.player.setSource,
    ).toHaveBeenCalledWith(generationAsset);
    expect(
      node.assetMaskNodes.get(generationMask.id)?.player.renderAt,
    ).toHaveBeenCalledWith(expect.any(Number), { strict: true });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    controller.dispose();
    warnSpy.mockRestore();
  });
});
