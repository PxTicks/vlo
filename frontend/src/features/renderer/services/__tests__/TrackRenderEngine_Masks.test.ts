import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";
import { TICKS_PER_SECOND } from "../../../timeline";

const drawMaskShapeSpy = vi.fn();
const sam2SetSourceSpy = vi.fn(async () => undefined);
const sam2RenderAtSpy = vi.fn(
  async (timeSeconds: number, options?: { strict?: boolean }) => {
    void timeSeconds;
    void options;
    return undefined;
  },
);
const sam2DisposeSpy = vi.fn();

vi.mock("../../workers/decoder.worker?worker", () => ({
  default: class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage = vi.fn((message: { type?: string; strict?: boolean; clipId?: string }) => {
      if (message.type === "render" && message.strict && this.onmessage) {
        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: "frame",
              bitmap: {},
              clipId: message.clipId,
            },
          } as MessageEvent);
        }, 0);
      }
    });
    terminate = vi.fn();
  },
}));

vi.mock("../../../masks/runtime/MaskVideoFramePlayer", () => ({
  MaskVideoFramePlayer: class {
    sprite = {
      visible: true,
      texture: { width: 100, height: 100 },
      position: { x: 0, y: 0, set: vi.fn() },
      scale: { x: 1, y: 1, set: vi.fn() },
      rotation: 0,
      anchor: { set: vi.fn() },
    };
    setSource = sam2SetSourceSpy;
    renderAt = sam2RenderAtSpy;
    dispose = sam2DisposeSpy;
  },
}));

vi.mock("../../../masks/model/maskFactory", () => ({
  drawMaskBaseShape: (...args: unknown[]) => drawMaskShapeSpy(...args),
  createMaskLayoutTransformsFromParameters: () => [],
}));

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual("pixi.js");
  return {
    ...actual,
    Texture: {
      from: vi.fn(() => ({
        width: 100,
        height: 100,
        destroy: vi.fn(),
      })),
      EMPTY: {},
    },
    Graphics: class {
      visible = false;
      position = { x: 0, y: 0, set: vi.fn() };
      scale = { x: 1, y: 1, set: vi.fn() };
      rotation = 0;
      clear = vi.fn(() => this);
      poly = vi.fn(() => this);
      fill = vi.fn(() => this);
    },
    Sprite: class {
      anchor = { set: vi.fn() };
      texture = { width: 100, height: 100, destroy: vi.fn() };
      visible = true;
      position = { x: 0, y: 0, set: vi.fn() };
      scale = { x: 1, y: 1, set: vi.fn() };
      rotation = 0;
      effects: unknown[] = [];
      mask: unknown = null;
      addChild = vi.fn();
      setMask = vi.fn();
      addEffect = vi.fn((effect: unknown) => {
        if (!this.effects.includes(effect)) {
          this.effects.push(effect);
        }
      });
      removeEffect = vi.fn((effect: unknown) => {
        this.effects = this.effects.filter((entry) => entry !== effect);
      });
      destroy = vi.fn();
    },
    AlphaMask: class {
      mask: unknown;
      inverse = false;
      constructor(options?: { mask?: unknown }) {
        this.mask = options?.mask ?? null;
      }
      destroy = vi.fn();
    },
    Container: class {
      parent: { removeChild: () => void } | null = null;
      destroyed = false;
      zIndex = 0;
      effects: unknown[] = [];
      mask: unknown = null;
      position = { x: 0, y: 0, set: vi.fn() };
      scale = { x: 1, y: 1, set: vi.fn() };
      rotation = 0;
      addChild = vi.fn();
      addChildAt = vi.fn();
      removeChild = vi.fn();
      setMask = vi.fn();
      addEffect = vi.fn((effect: unknown) => {
        if (!this.effects.includes(effect)) {
          this.effects.push(effect);
        }
      });
      removeEffect = vi.fn((effect: unknown) => {
        this.effects = this.effects.filter((entry) => entry !== effect);
      });
      removeFromParent = vi.fn();
      destroy = vi.fn(() => {
        this.destroyed = true;
      });
    },
  };
});

import { TrackRenderEngine } from "../TrackRenderEngine";

function createParentClip(
  overrides: Partial<StandardTimelineClip> = {},
): StandardTimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video",
    name: "Clip",
    assetId: "asset_1",
    sourceDuration: 500,
    start: 0,
    timelineDuration: 500,
    offset: 0,
    transformedDuration: 500,
    transformedOffset: 0,
    croppedSourceDuration: 500,
    transformations: [],
    clipComponents: [],
    ...overrides,
  };
}

function createMaskClip(
  localId: string,
  mode: "apply" | "preview" | "off",
): MaskTimelineClip {
  return {
    id: `clip_1::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 500,
    start: 0,
    timelineDuration: 500,
    offset: 0,
    transformedDuration: 500,
    transformedOffset: 0,
    croppedSourceDuration: 500,
    transformations: [],
    parentClipId: "clip_1",
    maskType: localId === "mask_apply" ? "rectangle" : "circle",
    maskMode: mode,
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
  };
}

function createSam2MaskClip(localId: string, assetId: string): MaskTimelineClip {
  return {
    ...createMaskClip(localId, "apply"),
    maskType: "sam2",
    sam2MaskAssetId: assetId,
  };
}

describe("TrackRenderEngine masks", () => {
  beforeEach(() => {
    drawMaskShapeSpy.mockReset();
    sam2SetSourceSpy.mockReset();
    sam2RenderAtSpy.mockReset();
    sam2DisposeSpy.mockReset();
  });

  it("applies only masks in apply mode", () => {
    const engine = new TrackRenderEngine(1);
    const setMaskSpy = vi.spyOn(engine.container, "setMask");

    const clip = createParentClip();
    const maskApply = createMaskClip("mask_apply", "apply");
    const maskPreview = createMaskClip("mask_preview", "preview");
    const maskOff = createMaskClip("mask_off", "off");

    const assets: Asset[] = [
      {
        id: "asset_1",
        src: "file://asset.mp4",
        name: "asset",
        hash: "hash",
        type: "video",
        createdAt: 0,
      },
    ];

    const masksByParent = new Map<string, MaskTimelineClip[]>([
      [clip.id, [maskApply, maskPreview, maskOff]],
    ]);

    engine.update(
      10,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30, shouldRender: false },
    );

    expect(drawMaskShapeSpy).toHaveBeenCalledTimes(1);
    expect(drawMaskShapeSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ id: maskApply.id }),
    );
    expect(setMaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mask: expect.anything(),
        inverse: false,
      }),
    );

    engine.dispose();
  });

  it("composites multiple SAM2 mask assets and requests strict frames in export mode", async () => {
    const engine = new TrackRenderEngine(1);
    const setMaskSpy = vi.spyOn(engine.container, "setMask");
    const addEffectSpy = vi.spyOn(engine.container, "addEffect");

    const clip = createParentClip();
    const sam2MaskA = createSam2MaskClip("mask_sam2_a", "sam2_asset_a");
    const sam2MaskB = createSam2MaskClip("mask_sam2_b", "sam2_asset_b");
    const assets: Asset[] = [
      {
        id: "asset_1",
        src: "file://asset.mp4",
        name: "asset",
        hash: "hash",
        type: "video",
        createdAt: 0,
      },
      {
        id: "sam2_asset_a",
        src: "file://sam2_a.mp4",
        name: "sam2_a",
        hash: "sam2_hash_a",
        type: "video",
        createdAt: 0,
      },
      {
        id: "sam2_asset_b",
        src: "file://sam2_b.mp4",
        name: "sam2_b",
        hash: "sam2_hash_b",
        type: "video",
        createdAt: 0,
      },
    ];
    const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));

    await engine.renderFrame(
      10,
      clip,
      { width: 1920, height: 1080 },
      [sam2MaskA, sam2MaskB],
      assetsById,
      { fps: 30 },
    );

    expect(sam2SetSourceSpy).toHaveBeenCalledTimes(2);
    expect(sam2RenderAtSpy).toHaveBeenCalledTimes(2);
    expect(
      sam2RenderAtSpy.mock.calls.every(
        (call) => call[1] && (call[1] as { strict?: boolean }).strict === true,
      ),
    ).toBe(true);
    expect(addEffectSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mask: expect.anything(),
        inverse: false,
      }),
    );
    expect(setMaskSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mask: expect.anything(),
        inverse: false,
      }),
    );

    engine.dispose();
  });

  it("snaps export mask sampling to the same frame grid as content", async () => {
    const engine = new TrackRenderEngine(1);
    const clip = createParentClip({
      sourceDuration: 10 * TICKS_PER_SECOND,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedDuration: 10 * TICKS_PER_SECOND,
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: TICKS_PER_SECOND / 60,
    });
    const sam2Mask = createSam2MaskClip("mask_sam2", "sam2_asset");
    const assets: Asset[] = [
      {
        id: "asset_1",
        src: "file://asset.mp4",
        name: "asset",
        hash: "hash",
        type: "video",
        createdAt: 0,
      },
      {
        id: "sam2_asset",
        src: "file://sam2.mp4",
        name: "sam2",
        hash: "sam2_hash",
        type: "video",
        createdAt: 0,
      },
    ];
    const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));

    await engine.renderFrame(
      0,
      clip,
      { width: 1920, height: 1080 },
      [sam2Mask],
      assetsById,
      { fps: 30 },
    );

    expect(sam2RenderAtSpy).toHaveBeenCalledTimes(1);
    expect(sam2RenderAtSpy.mock.calls[0]?.[0]).toBeCloseTo(1 / 30, 6);

    engine.dispose();
  });

  it("snaps synchronized playback mask sampling to the presentation frame grid", async () => {
    const engine = new TrackRenderEngine(1);
    const clip = createParentClip({
      sourceDuration: 10 * TICKS_PER_SECOND,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedDuration: 10 * TICKS_PER_SECOND,
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: TICKS_PER_SECOND / 60,
    });
    const sam2Mask = createSam2MaskClip("mask_sam2", "sam2_asset");
    const assets: Asset[] = [
      {
        id: "asset_1",
        src: "file://asset.mp4",
        name: "asset",
        hash: "hash",
        type: "video",
        createdAt: 0,
      },
      {
        id: "sam2_asset",
        src: "file://sam2.mp4",
        name: "sam2",
        hash: "sam2_hash",
        type: "video",
        createdAt: 0,
      },
    ];
    const masksByParent = new Map<string, MaskTimelineClip[]>([
      [clip.id, [sam2Mask]],
    ]);

    await engine.renderSynchronizedPlaybackFrame(
      0,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );

    expect(sam2RenderAtSpy).toHaveBeenCalledTimes(1);
    expect(sam2RenderAtSpy.mock.calls[0]?.[0]).toBeCloseTo(1 / 30, 6);

    engine.dispose();
  });
});
