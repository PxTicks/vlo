import { describe, expect, it, vi } from "vitest";
import { AlphaMask, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type {
  ClipTransform,
  MaskBooleanExpression,
  StandardTimelineClip,
} from "../../../../types/TimelineTypes";
import type { Component } from "../../../../types/Components";
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

function withMaskComposition(
  parent: TimelineClip,
  options: {
    expression?: MaskBooleanExpression | null;
    compositeTransformations?: ClipTransform[];
  },
): TimelineClip {
  if (parent.type === "mask") return parent;
  const standardParent = parent as StandardTimelineClip;
  const base = (standardParent.components ?? []).filter(
    (component) => component.type !== "mask_composition",
  );
  const compositionComponent: Component = {
    id: "mask_composition_test",
    type: "mask_composition",
    parameters: {
      ...(options.expression !== undefined
        ? { expression: options.expression }
        : {}),
      compositeTransformations: options.compositeTransformations ?? [],
    },
  };
  return {
    ...standardParent,
    components: [...base, compositionComponent],
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
  it("keeps the alpha-mask sprite active without rendering it as scene content", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      compositeTransformations: [
        {
          id: "grow_1",
          type: "mask_grow",
          isEnabled: true,
          parameters: {
            amount: 12,
          },
        },
      ],
    });
    const mask = createMaskClip("mask_alpha_scene");

    await controller.syncMaskClips(
      [mask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const maskSprite = (
      controller as unknown as {
        maskSprite: Sprite | null;
      }
    ).maskSprite;

    expect(maskSprite).not.toBeNull();
    expect(maskSprite?.visible).toBe(true);
    expect(maskSprite?.renderable).toBe(false);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("applies shared parent feathering as a post-composite pass", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      compositeTransformations: [
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
    const featheredMask = createMaskClip("mask_feathered");

    await controller.syncMaskClips(
      [featheredMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (sprite.effects?.find(
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
    expect(renderSpy).toHaveBeenCalledTimes(6);
    expect(node?.presentation).toBe("graphics");
    expect(node?.graphics.visible).toBe(true);
    expect(node?.spriteHost.visible).toBe(false);
    expect(node?.sprite.visible).toBe(false);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("applies shared hard outer feathering as an aligned blur and overlay pass", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      compositeTransformations: [
        {
          id: "feather_1",
          type: "feather",
          isEnabled: true,
          parameters: {
            mode: "hard_outer",
            amount: 20,
          },
        },
      ],
    });
    const featheredMask = createMaskClip("mask_hard_outer");

    await controller.syncMaskClips(
      [featheredMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (sprite.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(renderSpy).toHaveBeenCalledTimes(6);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("normalizes asset-backed generation masks before hard outer feathering", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      compositeTransformations: [
        {
          id: "feather_1",
          type: "feather",
          isEnabled: true,
          parameters: {
            mode: "hard_outer",
            amount: 20,
          },
        },
      ],
    });
    const generationMask = createMaskClip("mask_generation_hard_outer", {
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

    expect(renderSpy).toHaveBeenCalledTimes(6);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("composites a single inverted vector mask and keeps AlphaMask.inverse false", async () => {
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

    const alphaMaskEffect = (sprite.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(alphaMaskEffect?.inverse).toBe(false);
    // Render the inverted leaf through the shared scratch target, then present
    // the final red->alpha mask.
    expect(renderSpy).toHaveBeenCalledTimes(3);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("composites inverted masks per mask and keeps AlphaMask.inverse false", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown; filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
        filters: renderArgs.container?.filters,
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

    const alphaMaskEffect = (sprite.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(alphaMaskEffect?.inverse).toBe(false);

    // Render each referenced leaf once, using the shared scratch target for
    // the inverted leaf before the boolean combine and final presentation.
    expect(renderSpy).toHaveBeenCalledTimes(5);
    expect(
      renderSnapshots.some(
        (call) =>
          call.clear === true &&
          call.transform === undefined &&
          Array.isArray((call as { filters?: unknown }).filters),
      ),
    ).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("treats shared inverse masking as a composited hole-space union", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        filters: renderArgs.container?.filters,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      compositeTransformations: [
        {
          id: "grow_1",
          type: "mask_grow",
          isEnabled: true,
          parameters: {
            amount: 0,
            invert: true,
          },
        },
      ],
    });
    const maskA = createMaskClip("mask_a");
    const maskB = createMaskClip("mask_b", {
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [maskA, maskB],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const alphaMaskEffect = (sprite.effects?.find(
      (effect) => effect instanceof AlphaMask,
    ) ?? null) as AlphaMask | null;

    expect(alphaMaskEffect).not.toBeNull();
    expect(alphaMaskEffect?.inverse).toBe(false);
    expect(renderSpy).toHaveBeenCalledTimes(4);
    expect(
      renderSnapshots.filter((call) => call.transform !== undefined).length,
    ).toBe(2);
    expect(
      renderSnapshots.filter(
        (call) =>
          call.clear === true &&
          Array.isArray(call.filters),
      ).length,
    ).toBeGreaterThanOrEqual(2);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("renders multiple inverted masks as one erased union pass", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown; filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
        filters: renderArgs.container?.filters,
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

    // Render each inverted leaf through the shared scratch target, then run
    // one shader-based intersection before presenting red->alpha.
    expect(renderSpy).toHaveBeenCalledTimes(6);
    expect(
      renderSnapshots.filter((call) => call.transform !== undefined).length,
    ).toBe(2);
    expect(
      renderSnapshots.some(
        (call) =>
          call.clear === true &&
          call.transform === undefined &&
          Array.isArray((call as { filters?: unknown }).filters),
      ),
    ).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("evaluates an explicit intersection expression via multiply compositing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown; filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
        filters: renderArgs.container?.filters,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      expression: {
        kind: "operation",
        operator: "intersect",
        left: {
          kind: "mask_ref",
          maskId: "mask_a",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_b",
        },
      },
    });
    const maskA = createMaskClip("mask_a");
    const maskB = createMaskClip("mask_b", {
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [maskA, maskB],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    expect(renderSpy).toHaveBeenCalledTimes(4);
    expect(
      renderSnapshots.some(
        (call) =>
          call.clear === true &&
          call.transform === undefined &&
          Array.isArray((call as { filters?: unknown }).filters),
      ),
    ).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("evaluates an explicit union expression with a coverage-preserving combine shader", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown; filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
        filters: renderArgs.container?.filters,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      expression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_a",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_b",
        },
      },
      compositeTransformations: [
        {
          id: "grow_1",
          type: "mask_grow",
          isEnabled: true,
          parameters: {
            amount: 8,
          },
        },
      ],
    });
    const maskA = createMaskClip("mask_a");
    const maskB = createMaskClip("mask_b", {
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [maskA, maskB],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    const unionFilter = (
      controller as unknown as {
        maskBooleanBlendFilters: Partial<Record<"union", unknown>>;
      }
    ).maskBooleanBlendFilters.union;

    expect(unionFilter).toBeTruthy();
    expect(renderSpy).toHaveBeenCalledTimes(7);
    expect(
      renderSnapshots.some(
        (call) =>
          call.clear === true &&
          call.transform === undefined &&
          Array.isArray(call.filters) &&
          call.filters.includes(unionFilter),
      ),
    ).toBe(true);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("keeps explicit all-union vector expressions on the simple union fast path", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      expression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_a",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_b",
        },
      },
    });
    const maskA = createMaskClip("mask_a");
    const maskB = createMaskClip("mask_b", {
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [maskA, maskB],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    expect(renderSpy).not.toHaveBeenCalled();
    expect(
      (
        controller as unknown as {
          currentMaskMode: "none" | "regular" | "alpha";
          maskBooleanBlendFilters: Partial<Record<"union", unknown>>;
        }
      ).currentMaskMode,
    ).toBe("regular");
    expect(
      (
        controller as unknown as {
          currentMaskMode: "none" | "regular" | "alpha";
          maskBooleanBlendFilters: Partial<Record<"union", unknown>>;
        }
      ).maskBooleanBlendFilters.union,
    ).toBeUndefined();

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("evaluates nested minus expressions from the stored AST", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSnapshots: Array<{
      clear?: boolean;
      transform?: unknown;
      blendMode?: unknown;
      filters?: unknown;
    }> = [];
    const renderSpy = vi.fn((args: unknown) => {
      const renderArgs = args as {
        clear?: boolean;
        transform?: unknown;
        container?: { blendMode?: unknown; filters?: unknown };
      };
      renderSnapshots.push({
        clear: renderArgs.clear,
        transform: renderArgs.transform,
        blendMode: renderArgs.container?.blendMode,
        filters: renderArgs.container?.filters,
      });
    });
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = withMaskComposition(createParentClip(), {
      expression: {
        kind: "operation",
        operator: "subtract",
        left: {
          kind: "mask_ref",
          maskId: "mask_a",
        },
        right: {
          kind: "operation",
          operator: "union",
          left: {
            kind: "mask_ref",
            maskId: "mask_b",
          },
          right: {
            kind: "mask_ref",
            maskId: "mask_c",
          },
        },
      },
    });
    const maskA = createMaskClip("mask_a");
    const maskB = createMaskClip("mask_b", {
      maskType: "circle",
    });
    const maskC = createMaskClip("mask_c", {
      maskType: "triangle",
    });

    await controller.syncMaskClips(
      [maskA, maskB, maskC],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    expect(renderSpy).toHaveBeenCalledTimes(6);
    expect(
      renderSnapshots.filter(
        (call) =>
          call.clear === true &&
          call.transform === undefined &&
          Array.isArray((call as { filters?: unknown }).filters),
      ),
    ).toHaveLength(3);

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

    const alphaMaskEffect = (sprite.effects?.find(
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
    expect(renderSpy).toHaveBeenCalledTimes(2);

    controller.dispose();
    warnSpy.mockRestore();
  });
});
