import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";
import { TICKS_PER_SECOND } from "../../../timeline";
import { createDecoderWorkerPool, resetSharedDecoderWorkerPoolForTests } from "../DecoderWorkerPool";
import { resetDecoderWorkerRecoveryForTests } from "../../utils/decoderWorkerRecovery";

const {
  mockWorkerInstances,
  mockWorkerBehaviors,
  returnedBitmaps,
  textureFromSpy,
  syncMaskClipsSpy,
} = vi.hoisted(() => {
  const workerInstances: Array<{
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const workerBehaviors: Array<Array<"frame" | "hang">> = [];
  const returnedBitmaps: Array<{
    width: number;
    height: number;
    close: ReturnType<typeof vi.fn>;
  }> = [];
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
    returnedBitmaps,
    textureFromSpy,
    syncMaskClipsSpy,
  };
});

vi.mock("@decoder-worker-loader", () => ({
  default: class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    readonly postMessage = vi.fn(
      (message: {
        clipId?: string;
        pingId?: string;
        requestId?: string;
        strict?: boolean;
        transformTime?: number;
        type?: string;
      }) => {
        if (message.type === "ping") {
          setTimeout(() => {
            this.onmessage?.({
              data: {
                type: "worker-health",
                event: "pong",
                pingId: message.pingId,
              },
            } as MessageEvent);
          }, 0);
          return;
        }

        if (message.type !== "render" || !message.strict || !this.onmessage) {
          return;
        }

        const nextBehavior = this.behavior.shift() ?? "frame";
        if (nextBehavior === "hang") {
          return;
        }

        setTimeout(() => {
          const bitmap = {
            width: 320,
            height: 240,
            close: vi.fn(),
          };
          returnedBitmaps.push(bitmap);
          this.onmessage?.({
            data: {
              type: "frame",
              bitmap,
              clipId: message.clipId,
              requestId: message.requestId,
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
      setTimeout(() => {
        this.onmessage?.({
          data: {
            type: "worker-health",
            event: "boot",
          },
        } as MessageEvent);
      }, 0);
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
    components: [],
    ...overrides,
  } as TimelineClip;
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

function createEngine(options: { trackId?: string } = {}) {
  const decoderPool = createDecoderWorkerPool({
    label: "test",
    size: 1,
    idleRecycleMs: null,
  });
  const engine = new TrackRenderEngine(1, undefined, undefined, {
    decoderPool,
    trackId: options.trackId,
  });
  return { decoderPool, engine };
}

describe("TrackRenderEngine synchronized playback recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkerInstances.length = 0;
    mockWorkerBehaviors.length = 0;
    returnedBitmaps.length = 0;
    textureFromSpy.mockClear();
    syncMaskClipsSpy.mockClear();
    resetSharedDecoderWorkerPoolForTests();
    resetDecoderWorkerRecoveryForTests();
  });

  it("reuses an identical in-flight synchronized render request", async () => {
    mockWorkerBehaviors.push(["frame"]);

    const { engine, decoderPool } = createEngine();
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
    decoderPool.dispose();
  });

  it("closes unclaimed decoded frames without leaking the decoder lease after repeated aborts", async () => {
    mockWorkerBehaviors.push(["frame", "frame", "frame"]);

    const { engine, decoderPool } = createEngine({ trackId: "track-1" });
    const clip = createClip();
    const asset = createAsset();
    const job = engine.resolveFrameJob({
      epoch: 1,
      presentationTick: 2 * TICKS_PER_SECOND,
      trackClips: [clip],
      maskClipsByParent: new Map(),
      assetsById: new Map([[asset.id, asset]]),
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
    });
    expect(job).not.toBeNull();
    if (!job) {
      throw new Error("Expected a resolved video frame job");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const decode = engine.decodeResolvedSourceFrame(job, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(decode).rejects.toMatchObject({ name: "AbortError" });
      await vi.runAllTimersAsync();
    }

    expect(returnedBitmaps).toHaveLength(3);
    for (const bitmap of returnedBitmaps) {
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    }
    expect(engine["pendingResolve"]).toBeNull();
    expect(engine["pendingReject"]).toBeNull();
    const getLeaseCount = () =>
      (decoderPool as unknown as { leases: Map<string, unknown> }).leases.size;
    expect(getLeaseCount()).toBe(1);

    engine.dispose();
    expect(getLeaseCount()).toBe(0);
    decoderPool.dispose();
  });

  it("does not let a late aborted strict reply settle its replacement request", async () => {
    mockWorkerBehaviors.push(["hang", "hang"]);

    const { engine, decoderPool } = createEngine({ trackId: "track-1" });
    const clip = createClip();
    const asset = createAsset();
    const job = engine.resolveFrameJob({
      epoch: 1,
      presentationTick: 2 * TICKS_PER_SECOND,
      trackClips: [clip],
      maskClipsByParent: new Map(),
      assetsById: new Map([[asset.id, asset]]),
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
    });
    expect(job).not.toBeNull();
    if (!job) {
      throw new Error("Expected a resolved video frame job");
    }

    const controller = new AbortController();
    const abortedDecode = engine.decodeResolvedSourceFrame(job, {
      signal: controller.signal,
    });
    const worker = mockWorkerInstances[0];
    const firstRender = worker.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "render");
    controller.abort();
    await expect(abortedDecode).rejects.toMatchObject({ name: "AbortError" });

    const replacementDecode = engine.decodeResolvedSourceFrame(job);
    const renderMessages = worker.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "render");
    const replacementRender = renderMessages.at(-1);
    expect(firstRender?.requestId).toBeTypeOf("string");
    expect(replacementRender?.requestId).toBeTypeOf("string");
    expect(replacementRender?.requestId).not.toBe(firstRender?.requestId);

    const staleBitmap = {
      width: 320,
      height: 240,
      close: vi.fn(),
    };
    engine["handleLeaseFrame"]({
      bitmap: staleBitmap as unknown as ImageBitmap,
      clipId: clip.id,
      requestId: firstRender?.requestId,
    });
    expect(staleBitmap.close).toHaveBeenCalledTimes(1);
    expect(engine["pendingStrictFrameRequestId"]).toBe(
      replacementRender?.requestId,
    );

    const replacementBitmap = {
      width: 320,
      height: 240,
      close: vi.fn(),
    };
    engine["handleLeaseFrame"]({
      bitmap: replacementBitmap as unknown as ImageBitmap,
      clipId: clip.id,
      requestId: replacementRender?.requestId,
    });
    await expect(replacementDecode).resolves.toBe(replacementBitmap);
    expect(replacementBitmap.close).not.toHaveBeenCalled();
    replacementBitmap.close();

    engine.dispose();
    decoderPool.dispose();
  });

  it("routes a live reply to the live slot while a strict decode is pending", () => {
    const { engine, decoderPool } = createEngine({ trackId: "track-1" });
    const strictResolve = vi.fn();
    const liveResolve = vi.fn();
    const liveRequestId = engine["createDecoderFrameRequestId"]("live");

    engine["pendingResolve"] = strictResolve;
    engine["pendingStrictFrameRequestId"] =
      engine["createDecoderFrameRequestId"]("strict");
    engine["pendingLiveFrame"] = {
      resolve: liveResolve,
      reject: vi.fn(),
    };
    engine["pendingLiveFrameRequestId"] = liveRequestId;

    engine["handleLeaseFrame"]({
      bitmap: null,
      clipId: "clip-1",
      transformTime: 42,
      requestId: liveRequestId,
    });

    expect(liveResolve).toHaveBeenCalledWith({
      bitmap: null,
      clipId: "clip-1",
      transformTime: 42,
    });
    expect(strictResolve).not.toHaveBeenCalled();

    engine.dispose();
    decoderPool.dispose();
  });

  it("retries the same synchronized frame when no texture has been applied yet", async () => {
    mockWorkerBehaviors.push(["frame"]);

    const { engine, decoderPool } = createEngine();
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();
    const frameIndex = 60;
    engine["lastRenderRequest"] = {
      time: frameIndex / 30,
      clipId: clip.id,
      assetId: (clip as { assetId: string }).assetId,
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
    decoderPool.dispose();
  });

  it("drops a first synchronized timeout without recreating the worker", async () => {
    mockWorkerBehaviors.push(["hang"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
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
    await renderPromise;

    expect(mockWorkerInstances).toHaveLength(1);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();
    expect(mockWorkerInstances[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "render",
        clipId: expect.stringMatching(/\/clip-1$/),
        strict: true,
      }),
    );
    expect(engine["currentTextureClipId"]).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    engine.dispose();
    decoderPool.dispose();
  });

  it("disposes and re-prepares the synchronized source after consecutive timeouts", async () => {
    mockWorkerBehaviors.push(["frame", "hang", "hang", "frame"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();

    const warmRender = engine.renderSynchronizedPlaybackFrame(
      TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );
    await vi.runAllTimersAsync();
    await warmRender;

    const firstRender = engine.renderSynchronizedPlaybackFrame(
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
    await firstRender;

    const secondRender = engine.renderSynchronizedPlaybackFrame(
      3 * TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );

    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await secondRender;

    expect(
      mockWorkerInstances.some((worker) => worker.terminate.mock.calls.length > 0),
    ).toBe(false);
    expect(
      mockWorkerInstances.some((worker) =>
        worker.postMessage.mock.calls.some(
          ([message]) =>
            message.type === "dispose" &&
            /\/clip-1$/.test(String(message.clipId)),
        ),
      ),
    ).toBe(true);
    expect(
      mockWorkerInstances.some((worker) =>
        worker.postMessage.mock.calls.some(
          ([message]) =>
            message.type === "prepare" &&
            /\/clip-1$/.test(String(message.clipId)) &&
            message.file instanceof File,
        ),
      ),
    ).toBe(true);
    expect(
      mockWorkerInstances.some((worker) =>
        worker.postMessage.mock.calls.some(
          ([message]) =>
            message.type === "render" &&
            /\/clip-1$/.test(String(message.clipId)) &&
            message.strict === true,
        ),
      ),
    ).toBe(true);
    expect(engine["currentTextureClipId"]).toBe(clip.id);
    expect(engine.sprite.texture.width).toBe(320);
    expect(warnSpy).toHaveBeenCalledWith(
      "Live decoder worker stalled during synchronized playback; recovering decoder source",
      expect.any(Error),
    );

    warnSpy.mockRestore();
    engine.dispose();
    decoderPool.dispose();
  });

  it("renders the newest queued live request after an older timeout", async () => {
    mockWorkerBehaviors.push(["hang", "frame"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
    const clip = createClip();
    const assets = [createAsset()];
    const masksByParent = new Map<string, []>();

    engine.update(
      2 * TICKS_PER_SECOND,
      [clip],
      masksByParent,
      assets,
      { width: 1920, height: 1080 },
      { fps: 30 },
    );
    engine.update(
      3 * TICKS_PER_SECOND,
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

    const worker = mockWorkerInstances[0];
    expect(mockWorkerInstances).toHaveLength(1);
    expect(worker?.terminate).not.toHaveBeenCalled();
    expect(
      worker?.postMessage.mock.calls.filter(
        ([message]) => message.type === "render",
      ),
    ).toHaveLength(2);
    expect(engine["currentTextureClipId"]).toBe(clip.id);
    expect(engine.sprite.texture.width).toBe(320);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    engine.dispose();
    decoderPool.dispose();
  });

  it("does not reset the content worker when mask synchronization times out", async () => {
    mockWorkerBehaviors.push(["frame"]);
    const maskTimeout = new Error("Mask sync timed out");
    maskTimeout.name = "TimeoutError";
    syncMaskClipsSpy.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw maskTimeout;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
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

    await vi.runAllTimersAsync();
    await renderPromise;

    expect(mockWorkerInstances).toHaveLength(1);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to prepare synchronized playback frame",
      maskTimeout,
    );

    warnSpy.mockRestore();
    engine.dispose();
    decoderPool.dispose();
  });
});
