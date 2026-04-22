import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";
import { TICKS_PER_SECOND } from "../../../timeline";

const {
  mockWorkerInstances,
  mockWorkerBehaviors,
  textureFromSpy,
  syncMaskClipsSpy,
} = vi.hoisted(() => {
  const workerInstances: Array<{
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const workerBehaviors: Array<Array<"frame" | "hang">> = [];
  const textureFromSpy = vi.fn((bitmap?: { width?: number; height?: number }) => ({
    width: bitmap?.width ?? 100,
    height: bitmap?.height ?? 100,
    source: {
      width: bitmap?.width ?? 100,
      height: bitmap?.height ?? 100,
    },
    destroy: vi.fn(),
  }));
  const syncMaskClipsSpy = vi.fn(async () => undefined);

  return {
    mockWorkerInstances: workerInstances,
    mockWorkerBehaviors: workerBehaviors,
    textureFromSpy,
    syncMaskClipsSpy,
  };
});

vi.mock("../../workers/decoder.worker?worker", () => ({
  default: class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    readonly postMessage = vi.fn(
      (message: {
        clipId?: string;
        strict?: boolean;
        transformTime?: number;
        type?: string;
      }) => {
        if (message.type !== "render" || !message.strict || !this.onmessage) {
          return;
        }

        const nextBehavior = this.behavior.shift() ?? "frame";
        if (nextBehavior === "hang") {
          return;
        }

        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: "frame",
              bitmap: {
                width: 320,
                height: 240,
                close: vi.fn(),
              },
              clipId: message.clipId,
              transformTime: message.transformTime,
            },
          } as MessageEvent);
        }, 0);
      },
    );
    readonly terminate = vi.fn();
    private readonly behavior: Array<"frame" | "hang">;

    constructor() {
      this.behavior = mockWorkerBehaviors.shift() ?? ["frame"];
      mockWorkerInstances.push(this);
    }
  },
}));

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual("pixi.js");
  const textureEmpty = { width: 1, height: 1, destroy: vi.fn() };

  class MockSprite {
    anchor = { set: vi.fn() };
    texture = textureEmpty;
    visible = true;
    position = { x: 0, y: 0, set: vi.fn() };
    scale = { x: 1, y: 1, set: vi.fn() };
    rotation = 0;
    destroy = vi.fn();
  }

  class MockContainer {
    parent: MockContainer | null = null;
    destroyed = false;
    zIndex = 0;
    children: unknown[] = [];
    addChild = vi.fn((child: { parent?: MockContainer | null }) => {
      child.parent = this;
      this.children.push(child);
      return child;
    });
    removeChild = vi.fn();
    removeFromParent = vi.fn(() => {
      this.parent = null;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  }

  return {
    ...actual,
    Container: MockContainer,
    Sprite: MockSprite,
    Texture: {
      from: textureFromSpy,
      EMPTY: textureEmpty,
    },
  };
});

vi.mock("../../../transformations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../transformations")>();
  return {
    ...actual,
    applyClipTransforms: vi.fn(),
  };
});

vi.mock("../../../masks/runtime/SpriteClipMaskController", () => ({
  SpriteClipMaskController: class {
    syncMaskClips = syncMaskClipsSpy;
    clear = vi.fn();
    dispose = vi.fn();
    syncMaskSpriteTransform = vi.fn();
  },
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: vi.fn(async () => null),
}));

import { TrackRenderEngine } from "../TrackRenderEngine";

function createClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    type: "video",
    name: "Clip 1",
    assetId: "asset-1",
    sourceDuration: 10 * TICKS_PER_SECOND,
    start: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    transformations: [],
    clipComponents: [],
    ...overrides,
  } satisfies TimelineClip;
}

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    src: "blob:asset-1",
    name: "Asset 1",
    hash: "hash-1",
    type: "video",
    file: new File(["video"], "asset-1.mp4", { type: "video/mp4" }),
    createdAt: 0,
    ...overrides,
  };
}

describe("TrackRenderEngine synchronized playback recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkerInstances.length = 0;
    mockWorkerBehaviors.length = 0;
    textureFromSpy.mockClear();
    syncMaskClipsSpy.mockClear();
  });

  it("reuses an identical in-flight synchronized render request", async () => {
    mockWorkerBehaviors.push(["frame"]);

    const engine = new TrackRenderEngine(1);
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();

    const renderA = engine.renderSynchronizedPlaybackFrame(
      2 * TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );
    const renderB = engine.renderSynchronizedPlaybackFrame(
      2 * TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );

    await vi.runAllTimersAsync();
    await Promise.all([renderA, renderB]);

    const worker = mockWorkerInstances[0];
    expect(worker).toBeDefined();
    expect(
      worker.postMessage.mock.calls.filter(
        ([message]) => message.type === "render",
      ),
    ).toHaveLength(1);
    expect(engine["currentTextureClipId"]).toBe(clip.id);
    expect(engine.sprite.texture.width).toBe(320);

    engine.dispose();
  });

  it("retries the same synchronized frame when no texture has been applied yet", async () => {
    mockWorkerBehaviors.push(["frame"]);

    const engine = new TrackRenderEngine(1);
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();
    const frameIndex = 60;
    engine["lastRenderRequest"] = {
      time: frameIndex / 30,
      clipId: clip.id,
      assetId: clip.assetId,
      frameIndex,
    };
    engine["currentTextureClipId"] = null;

    const renderPromise = engine.renderSynchronizedPlaybackFrame(
      frameIndex * (TICKS_PER_SECOND / 30),
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );
    await vi.runAllTimersAsync();
    await renderPromise;

    const worker = mockWorkerInstances[0];
    expect(
      worker.postMessage.mock.calls.some(
        ([message]) => message.type === "render",
      ),
    ).toBe(true);
    expect(engine["currentTextureClipId"]).toBe(clip.id);

    engine.dispose();
  });

  it("recreates the stalled worker and re-prepares the active clip after a timeout", async () => {
    mockWorkerBehaviors.push(["hang"], ["frame"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const engine = new TrackRenderEngine(1);
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();

    const renderPromise = engine.renderSynchronizedPlaybackFrame(
      2 * TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );

    const timeoutMs = (
      TrackRenderEngine as unknown as Record<string, number>
    )["LIVE_FRAME_TIMEOUT_MS"];
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await renderPromise;

    expect(mockWorkerInstances).toHaveLength(2);
    expect(mockWorkerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(mockWorkerInstances[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prepare",
        clipId: clip.id,
        file: expect.any(File),
      }),
    );
    expect(mockWorkerInstances[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "render",
        clipId: clip.id,
        strict: true,
      }),
    );
    expect(engine["currentTextureClipId"]).toBe(clip.id);
    expect(engine.sprite.texture.width).toBe(320);
    expect(warnSpy).toHaveBeenCalledWith(
      "Live decoder worker stalled during synchronized playback; recreating worker",
      expect.any(Error),
    );

    warnSpy.mockRestore();
    engine.dispose();
  });
});
