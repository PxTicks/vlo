import { describe, expect, it, vi } from "vitest";
import { AlphaMask, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type {
  ClipTransform,
  ClipMask,
  MaskBooleanExpression,
  StandardTimelineClip,
} from "../../../../types/TimelineTypes";
import type {
  Component,
  MaskCompositionAlgebra,
} from "../../../../types/Components";
import type { Asset } from "../../../../types/Asset";
import { livePreviewParamStore } from "../../../transformations";
import {
  createMaskLayoutTransforms,
  getMaskLayoutState,
} from "../../model/maskFactory";
import { createMaskRenderableShapeSource } from "../../model/maskRenderableLayout";
import { resolveMaskRenderableLayout } from "../resolveMaskRenderableLayout";

const { mockBrushSetHydrationContext, mockBrushSetSource } = vi.hoisted(() => ({
  mockBrushSetHydrationContext: vi.fn(),
  mockBrushSetSource: vi.fn(async () => undefined),
}));

vi.mock("../MaskVideoFramePlayer", async () => {
  const { Sprite, Texture } = await import("pixi.js");

  class MockMaskVideoFramePlayer {
    public readonly sprite: Sprite;
    private decodedFrame = false;
    public readonly setSource = vi.fn(async () => undefined);
    public readonly renderAt = vi.fn(async () => {
      this.decodedFrame = true;
    });
    public readonly hasFrame = vi.fn(() => this.decodedFrame);
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

vi.mock("../BrushBufferMaskSource", async () => {
  const { Sprite, Texture } = await import("pixi.js");

  class MockBrushBufferMaskSource {
    public readonly sprite: Sprite;
    public readonly setHydrationContext = mockBrushSetHydrationContext;
    public readonly setSource = mockBrushSetSource;
    public readonly renderAt = vi.fn(async () => undefined);
    public readonly hasFrame = vi.fn(() => true);
    public readonly dispose = vi.fn(() => undefined);

    constructor(...args: [string]) {
      void args;
      this.sprite = new Sprite(Texture.WHITE);
      this.sprite.anchor.set(0.5);
      this.sprite.visible = true;
    }
  }

  return {
    BrushBufferMaskSource: MockBrushBufferMaskSource,
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
    algebra?: MaskCompositionAlgebra;
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
      ...(options.algebra !== undefined ? { algebra: options.algebra } : {}),
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
    sam2GrowAmount?: number;
    sam2MaskAssetId?: string;
    generationMaskAssetId?: string;
    brushMaskAssetId?: string;
    brushPaintedBounds?: MaskTimelineClip["brushPaintedBounds"];
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
    sam2GrowAmount: options.sam2GrowAmount,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    sam2MaskAssetId: options.sam2MaskAssetId,
    generationMaskAssetId: options.generationMaskAssetId,
    brushMaskAssetId: options.brushMaskAssetId,
    brushPaintedBounds: options.brushPaintedBounds,
  };
}

function createMaskAsset(id: string): Asset {
  return {
    id,
    type: "video",
    name: `${id}.mp4`,
    src: `${id}.mp4`,
    hash: `${id}-hash`,
    createdAt: 0,
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

describe("SpriteClipMaskController mask composition", () => {
  it("hydrates persisted brush masks during normal mask sync", async () => {
    mockBrushSetHydrationContext.mockClear();
    mockBrushSetSource.mockClear();

    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const brushMask = createMaskClip("mask_brush", {
      maskType: "brush",
      brushMaskAssetId: "brush-mask-asset",
      brushPaintedBounds: { x: 12, y: 18, width: 44, height: 30 },
    });
    const brushAsset = createImageAsset("brush-mask-asset");

    await controller.syncMaskClips(
      [brushMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[brushAsset.id, brushAsset]]),
    );

    expect(mockBrushSetHydrationContext).toHaveBeenCalledWith({
      canvasWidth: 100,
      canvasHeight: 100,
      paintedBounds: { x: 12, y: 18, width: 44, height: 30 },
    });
    expect(mockBrushSetSource).toHaveBeenCalledWith(brushAsset);

    controller.dispose();
  });

  it("hydrates image-backed SAM2 masks through the image mask path", async () => {
    mockBrushSetHydrationContext.mockClear();
    mockBrushSetSource.mockClear();

    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite();
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const sam2Mask = createMaskClip("mask_sam2_image", {
      maskType: "sam2",
      sam2MaskAssetId: "sam2-image-mask-asset",
    });
    const sam2Asset = createImageAsset("sam2-image-mask-asset");

    await controller.syncMaskClips(
      [sam2Mask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[sam2Asset.id, sam2Asset]]),
    );

    expect(mockBrushSetHydrationContext).toHaveBeenCalledWith({
      canvasWidth: 1920,
      canvasHeight: 1080,
      paintedBounds: null,
    });
    expect(mockBrushSetSource).toHaveBeenCalledWith(sam2Asset);

    controller.dispose();
  });

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
      algebra: "normal",
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

  it("uses inverse algebra by default for explicit all-union vector expressions", async () => {
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
    const maskA = createMaskClip("mask_a", { inverted: true });
    const maskB = createMaskClip("mask_b", {
      inverted: true,
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
        currentMaskMode: "none" | "regular" | "alpha";
        maskBooleanBlendFilters: Partial<
          Record<
            "union",
            {
              resources: {
                filterUniforms: {
                  uniforms: {
                    uOperateOnInverseCoverage: number;
                  };
                };
              };
            }
          >
        >;
      }
    ).maskBooleanBlendFilters.union;

    expect(
      (
        controller as unknown as {
          currentMaskMode: "none" | "regular" | "alpha";
        }
      ).currentMaskMode,
    ).toBe("alpha");
    expect(unionFilter).toBeTruthy();
    expect(
      unionFilter?.resources.filterUniforms.uniforms.uOperateOnInverseCoverage,
    ).toBe(1);
    expect(renderSpy).toHaveBeenCalledTimes(6);
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

  it.each([
    { operator: "union", algebra: "normal" },
    { operator: "union", algebra: "inverse" },
    { operator: "intersect", algebra: "normal" },
    { operator: "intersect", algebra: "inverse" },
    { operator: "subtract", algebra: "normal" },
    { operator: "subtract", algebra: "inverse" },
  ] as const)(
    "treats a pending SAM2 mask as an identity for $operator in $algebra algebra",
    async ({ operator, algebra }) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const renderSpy = vi.fn();
      const renderer = {
        render: renderSpy,
      } as unknown as Renderer;
      const sprite = new Sprite(Texture.WHITE);
      const root = new Container();
      const controller = new SpriteClipMaskController(sprite, renderer, root);

      const parent = withMaskComposition(createParentClip(), {
        expression: {
          kind: "operation",
          operator,
          left: {
            kind: "mask_ref",
            maskId: "mask_a",
          },
          right: {
            kind: "mask_ref",
            maskId: "mask_pending",
          },
        },
        algebra,
      });
      const maskA = createMaskClip("mask_a");
      const pendingSam2Mask = createMaskClip("mask_pending", {
        maskType: "sam2",
      });

      await controller.syncMaskClips(
        [maskA, pendingSam2Mask],
        parent,
        { width: 1920, height: 1080 },
        10,
        new Map<string, Asset>(),
      );

      const internals = controller as unknown as {
        currentMaskMode: "none" | "regular" | "alpha";
        maskBooleanBlendFilters: Partial<
          Record<"union" | "intersect" | "subtract", unknown>
        >;
      };
      const alphaMaskEffect = (sprite.effects?.find(
        (effect) => effect instanceof AlphaMask,
      ) ?? null) as AlphaMask | null;

      expect(alphaMaskEffect).not.toBeNull();
      expect(alphaMaskEffect?.inverse).toBe(false);
      expect(internals.currentMaskMode).toBe("alpha");
      expect(internals.maskBooleanBlendFilters[operator]).toBeUndefined();
      expect(renderSpy).toHaveBeenCalledTimes(2);

      controller.dispose();
      warnSpy.mockRestore();
    },
  );

  it("keeps explicit normal all-union vector expressions on the simple union fast path", async () => {
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
      algebra: "normal",
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
      algebra: "normal",
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

  it("grows SAM2 leaf masks before boolean composition only when amount is non-zero", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderSpy = vi.fn();
    const renderer = {
      render: renderSpy,
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const sam2Mask = createMaskClip("mask_sam2", {
      maskType: "sam2",
      sam2MaskAssetId: "sam2-mask-asset",
      sam2GrowAmount: 0,
    });
    const sam2Asset = createMaskAsset("sam2-mask-asset");

    await controller.syncMaskClips(
      [sam2Mask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[sam2Asset.id, sam2Asset]]),
      { waitForSam2: true },
    );

    expect(renderSpy).toHaveBeenCalledTimes(2);

    await controller.syncMaskClips(
      [{ ...sam2Mask, sam2GrowAmount: 10 }],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[sam2Asset.id, sam2Asset]]),
      { waitForSam2: true },
    );

    expect(renderSpy).toHaveBeenCalledTimes(7);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("requests a missing SAM2 frame during transform-only mask sync", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const sam2Mask = createMaskClip("mask_sam2_skip", {
      maskType: "sam2",
      sam2MaskAssetId: "sam2-mask-asset-skip",
    });
    const sam2Asset = createMaskAsset("sam2-mask-asset-skip");

    await controller.syncMaskClips(
      [sam2Mask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[sam2Asset.id, sam2Asset]]),
      { skipSam2FrameRender: true },
    );

    const node = (
      controller as unknown as {
        assetMaskNodes: Map<
          string,
          {
            player: {
              renderAt: ReturnType<typeof vi.fn>;
            };
          }
        >;
      }
    ).assetMaskNodes.get(sam2Mask.id);

    expect(node?.player.renderAt).toHaveBeenCalledWith(expect.any(Number));

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("keeps a gizmo-moved generation mask aligned with the rendered asset rectangle", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const generationMask = createMaskClip("mask_generation_aligned", {
      maskType: "generation",
      generationMaskAssetId: "generation-mask-asset-aligned",
      transformations: createMaskLayoutTransforms(
        "clip_1::mask::mask_generation_aligned",
        {
          x: 48,
          y: -22,
          scaleX: 1.4,
          scaleY: 0.8,
          rotation: 0.35,
        },
      ),
    });
    const generationAsset = createMaskAsset("generation-mask-asset-aligned");

    await controller.syncMaskClips(
      [generationMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map([[generationAsset.id, generationAsset]]),
      { waitForSam2: true },
    );

    const node = (
      controller as unknown as {
        assetMaskNodes: Map<
          string,
          {
            player: {
              sprite: Sprite;
            };
          }
        >;
      }
    ).assetMaskNodes.get(generationMask.id);

    const resolved = resolveMaskRenderableLayout(generationMask, {
      rawTimeTicks: 10,
      parentClipContentSize: { width: 1920, height: 1080 },
      assetTextureSize: {
        width: node?.player.sprite.texture.width ?? 1,
        height: node?.player.sprite.texture.height ?? 1,
      },
    });
    const overlayShape = createMaskRenderableShapeSource(generationMask, resolved);
    const overlayLayout = getMaskLayoutState(
      overlayShape as unknown as ClipMask,
    );

    expect(overlayShape?.maskParameters).toEqual({
      baseWidth: node?.player.sprite.texture.width ?? 1,
      baseHeight: node?.player.sprite.texture.height ?? 1,
    });
    expect(overlayLayout.x).toBe(node?.player.sprite.position.x);
    expect(overlayLayout.y).toBe(node?.player.sprite.position.y);
    expect(overlayLayout.scaleX).toBe(node?.player.sprite.scale.x);
    expect(overlayLayout.scaleY).toBe(node?.player.sprite.scale.y);
    expect(overlayLayout.rotation).toBe(node?.player.sprite.rotation);

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("rebinds the regular Pixi mask when the active mask set changes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sprite = new Sprite(Texture.WHITE);
    const setMaskSpy = vi.spyOn(
      sprite as Sprite & {
        setMask: (options: { mask: Container | null; inverse: boolean }) => void;
      },
      "setMask",
    );
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, null, root);

    const parent = createParentClip();
    const firstMask = createMaskClip("mask_first");
    const secondMask = createMaskClip("mask_second", {
      maskType: "circle",
    });

    await controller.syncMaskClips(
      [firstMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );
    await controller.syncMaskClips(
      [firstMask, secondMask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    expect(setMaskSpy).toHaveBeenCalledTimes(2);
    expect(setMaskSpy).toHaveBeenLastCalledWith({
      mask: expect.any(Container),
      inverse: false,
    });

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("uses live preview values for shared mask edge operations", async () => {
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
          id: "grow_preview",
          type: "mask_grow",
          isEnabled: true,
          parameters: {
            amount: 0,
          },
        },
      ],
    });
    const mask = createMaskClip("mask_live_preview");

    livePreviewParamStore.set("grow_preview", "amount", 12);
    await controller.syncMaskClips(
      [mask],
      parent,
      { width: 1920, height: 1080 },
      10,
      new Map<string, Asset>(),
    );

    expect(renderSpy).toHaveBeenCalled();

    livePreviewParamStore.clear("grow_preview", "amount");
    controller.dispose();
    warnSpy.mockRestore();
  });

  it("treats a vector mask outside its activeRange as a no-op", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    const parent = createParentClip();
    const ranged: MaskTimelineClip = {
      ...createMaskClip("mask_range", { maskType: "circle" }),
      activeRange: { startSourceTicks: 100, endSourceTicks: 200 },
    };
    const internals = controller as unknown as { currentMaskMode: string };

    // Outside the range the mask is dropped entirely.
    await controller.syncMaskClips(
      [ranged],
      parent,
      { width: 1920, height: 1080 },
      50,
      new Map<string, Asset>(),
    );
    expect(internals.currentMaskMode).toBe("none");
    expect(sprite.mask ?? null).toBeNull();

    // Inside the range, the mask applies (stencil-mask path for a single
    // non-inverted vector mask).
    await controller.syncMaskClips(
      [ranged],
      parent,
      { width: 1920, height: 1080 },
      150,
      new Map<string, Asset>(),
    );
    expect(internals.currentMaskMode).toBe("regular");
    expect(sprite.mask).not.toBeNull();

    // Step back outside — the mask becomes a no-op again.
    await controller.syncMaskClips(
      [ranged],
      parent,
      { width: 1920, height: 1080 },
      300,
      new Map<string, Asset>(),
    );
    expect(internals.currentMaskMode).toBe("none");

    controller.dispose();
    warnSpy.mockRestore();
  });

  it("respects activeRange in source ticks across speed transforms", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderer = {
      render: vi.fn(),
    } as unknown as Renderer;
    const sprite = new Sprite(Texture.WHITE);
    const root = new Container();
    const controller = new SpriteClipMaskController(sprite, renderer, root);

    // Parent runs at 2x speed: visual time t maps to source time 2t.
    const baseParent = createParentClip();
    const parent: TimelineClip = {
      ...baseParent,
      transformations: [
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
    };
    const ranged: MaskTimelineClip = {
      ...createMaskClip("mask_speed_range", { maskType: "circle" }),
      activeRange: { startSourceTicks: 100, endSourceTicks: 200 },
    };
    const internals = controller as unknown as { currentMaskMode: string };

    // Visual t=40 → source 80, outside [100,200] → no-op.
    await controller.syncMaskClips(
      [ranged],
      parent,
      { width: 1920, height: 1080 },
      40,
      new Map<string, Asset>(),
    );
    expect(internals.currentMaskMode).toBe("none");

    // Visual t=60 → source 120, inside [100,200] → mask applies.
    await controller.syncMaskClips(
      [ranged],
      parent,
      { width: 1920, height: 1080 },
      60,
      new Map<string, Asset>(),
    );
    expect(internals.currentMaskMode).toBe("regular");

    controller.dispose();
    warnSpy.mockRestore();
  });
});
