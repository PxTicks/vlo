import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";
import { TICKS_PER_SECOND } from "../../../timeline";
import {
  createDecoderWorkerPool,
  resetSharedDecoderWorkerPoolForTests,
} from "../DecoderWorkerPool";
import { resetDecoderWorkerRecoveryForTests } from "../../utils/decoderWorkerRecovery";

type StrictReplyBehavior = "frame" | "null-plain" | "null-missing" | "null-error";

const { mockWorkerBehaviors, textureFromSpy, syncMaskClipsSpy } = vi.hoisted(
  () => {
    const workerBehaviors: Array<Array<StrictReplyBehavior>> = [];
    const textureFromSpy = vi.fn(
      (bitmap?: { width?: number; height?: number }) => ({
        width: bitmap?.width ?? 100,
        height: bitmap?.height ?? 100,
        source: {
          width: bitmap?.width ?? 100,
          height: bitmap?.height ?? 100,
        },
        destroy: vi.fn(),
      }),
    );
    const syncMaskClipsSpy = vi.fn(async () => undefined);

    return {
      mockWorkerBehaviors: workerBehaviors,
      textureFromSpy,
      syncMaskClipsSpy,
    };
  },
);

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

        const behavior = this.behavior.shift() ?? "frame";
        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: "frame",
              bitmap:
                behavior === "frame"
                  ? { width: 320, height: 240, close: vi.fn() }
                  : null,
              clipId: message.clipId,
              requestId: message.requestId,
              transformTime: message.transformTime,
              ...(behavior === "null-missing"
                ? { reason: "missing-renderer" }
                : {}),
              ...(behavior === "null-error" ? { error: "decode failed" } : {}),
            },
          } as MessageEvent);
        }, 0);
      },
    );
    readonly terminate = vi.fn();
    private readonly behavior: Array<StrictReplyBehavior>;

    constructor() {
      this.behavior = mockWorkerBehaviors.shift() ?? ["frame"];
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

function createEngine() {
  const decoderPool = createDecoderWorkerPool({
    label: "test",
    size: 1,
    idleRecycleMs: null,
  });
  const engine = new TrackRenderEngine(1, undefined, undefined, {
    decoderPool,
  });
  return { decoderPool, engine };
}

async function renderStrictFrame(
  engine: TrackRenderEngine,
  clip: TimelineClip,
  assetsById: Map<string, Asset>,
  tick: number,
): Promise<void> {
  const renderPromise = engine.renderFrame(
    tick,
    clip,
    { width: 1920, height: 1080 },
    [],
    assetsById,
    { fps: 30 },
  );
  await vi.runAllTimersAsync();
  await renderPromise;
}

describe("TrackRenderEngine strict render health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkerBehaviors.length = 0;
    textureFromSpy.mockClear();
    syncMaskClipsSpy.mockClear();
    resetSharedDecoderWorkerPoolForTests();
    resetDecoderWorkerRecoveryForTests();
  });

  it("tallies frameless strict replies and resets on consume", async () => {
    mockWorkerBehaviors.push([
      "frame",
      "null-missing",
      "null-error",
      "null-missing",
    ]);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
    const clip = createClip();
    const assetsById = new Map([["asset-1", createAsset()]]);

    const ticksPerFrame = TICKS_PER_SECOND / 30;
    for (let frame = 0; frame < 4; frame += 1) {
      await renderStrictFrame(engine, clip, assetsById, frame * ticksPerFrame);
    }

    expect(engine.consumeStrictRenderHealth()).toEqual({
      replies: 4,
      nullFrames: 3,
      missingRendererFrames: 2,
      errorFrames: 1,
    });
    // Issues are logged once per clip, then counted silently.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    expect(engine.consumeStrictRenderHealth()).toEqual({
      replies: 0,
      nullFrames: 0,
      missingRendererFrames: 0,
      errorFrames: 0,
    });

    engine.dispose();
    decoderPool.dispose();
    consoleErrorSpy.mockRestore();
  });

  it("keeps healthy renders out of the issue log", async () => {
    mockWorkerBehaviors.push(["frame", "frame"]);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { engine, decoderPool } = createEngine();
    const clip = createClip();
    const assetsById = new Map([["asset-1", createAsset()]]);

    const ticksPerFrame = TICKS_PER_SECOND / 30;
    await renderStrictFrame(engine, clip, assetsById, 0);
    await renderStrictFrame(engine, clip, assetsById, ticksPerFrame);

    expect(engine.consumeStrictRenderHealth()).toEqual({
      replies: 2,
      nullFrames: 0,
      missingRendererFrames: 0,
      errorFrames: 0,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    engine.dispose();
    decoderPool.dispose();
    consoleErrorSpy.mockRestore();
  });
});
