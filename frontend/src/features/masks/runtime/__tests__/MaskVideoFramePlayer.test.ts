import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";

type MockRenderStep =
  | "error"
  | "frame"
  | "hang"
  | {
      bitmap: { width?: number; height?: number };
    };

const { mockWorkers, mockWorkerPlans } = vi.hoisted(() => {
  const workers: Array<{
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const plans: Array<{
    prepare?: "error" | "hang" | "ready";
    render?: MockRenderStep[];
  }> = [];

  return {
    mockWorkers: workers,
    mockWorkerPlans: plans,
  };
});

vi.mock("../../../renderer", () => ({
  DecoderWorker: class MockWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly postMessage = vi.fn(
      (message: {
        clipId: string;
        strict?: boolean;
        time?: number;
        type: "prepare" | "render";
      }) => {
        if (!this.onmessage) {
          return;
        }

        if (message.type === "prepare") {
          const prepareBehavior = this.plan.prepare ?? "ready";
          if (prepareBehavior === "hang") {
            return;
          }

          setTimeout(() => {
            if (prepareBehavior === "error") {
              this.onmessage?.({
                data: {
                  type: "error",
                  message: "prepare failed",
                },
              } as MessageEvent);
              return;
            }

            this.onmessage?.({
              data: {
                type: "ready",
                clipId: message.clipId,
              },
            } as MessageEvent);
          }, 0);
          return;
        }

        const renderBehavior = this.plan.render.shift() ?? "frame";
        if (renderBehavior === "hang") {
          return;
        }

        setTimeout(() => {
          if (renderBehavior === "error") {
            this.onmessage?.({
              data: {
                type: "error",
                message: "render failed",
              },
            } as MessageEvent);
            return;
          }

          this.onmessage?.({
            data: {
              type: "frame",
              clipId: message.clipId,
              bitmap:
                renderBehavior === "frame" ? null : renderBehavior.bitmap,
            },
          } as MessageEvent);
        }, 0);
      },
    );
    readonly terminate = vi.fn();
    private readonly plan: {
      prepare?: "error" | "hang" | "ready";
      render: MockRenderStep[];
    };

    constructor() {
      const nextPlan = mockWorkerPlans.shift() ?? {};
      this.plan = {
        prepare: nextPlan.prepare,
        render: [...(nextPlan.render ?? [])],
      };
      mockWorkers.push(this);
    }
  },
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: vi.fn(async () => null),
}));

vi.mock("pixi.js", () => {
  const textureEmpty = {
    width: 1,
    height: 1,
    destroyed: false,
    destroy: vi.fn(),
  };

  class MockSprite {
    anchor = { set: vi.fn() };
    texture = textureEmpty;
    visible = true;
    destroyed = false;
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  }

  return {
    Sprite: MockSprite,
    Texture: {
      from: vi.fn((bitmap?: { width?: number; height?: number }) => ({
        width: bitmap?.width ?? 1,
        height: bitmap?.height ?? 1,
        destroyed: false,
        destroy: vi.fn(),
      })),
      EMPTY: textureEmpty,
    },
  };
});

import { MaskVideoFramePlayer } from "../MaskVideoFramePlayer";

function createMaskAsset(id: string): Asset {
  return {
    id,
    type: "video",
    name: `${id}.webm`,
    src: `blob:${id}`,
    hash: `${id}-hash`,
    createdAt: 0,
  };
}

describe("MaskVideoFramePlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkers.length = 0;
    mockWorkerPlans.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes overlapping strict frame requests", async () => {
    mockWorkerPlans.push({
      prepare: "ready",
      render: ["frame", "frame"],
    });

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));
    await vi.runAllTimersAsync();
    await setSourcePromise;

    const worker = mockWorkers[0];
    expect(worker).toBeDefined();

    const firstRender = player.renderAt(0, { strict: true });
    const secondRender = player.renderAt(1, { strict: true });
    await Promise.resolve();
    await Promise.resolve();

    const renderMessagesBeforeResolve = worker.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === "render");
    expect(renderMessagesBeforeResolve).toHaveLength(1);
    expect(renderMessagesBeforeResolve[0]?.time).toBe(0);

    await vi.runAllTimersAsync();
    await Promise.all([firstRender, secondRender]);

    const renderMessagesAfterResolve = worker.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === "render");
    expect(renderMessagesAfterResolve).toHaveLength(2);
    expect(renderMessagesAfterResolve[1]?.time).toBe(1);

    player.dispose();
  });

  it("recreates the stalled worker and retries source preparation after a timeout", async () => {
    mockWorkerPlans.push({ prepare: "hang" }, { prepare: "ready" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));

    const timeoutMs = (
      MaskVideoFramePlayer as unknown as Record<string, number>
    )["SOURCE_PREPARE_TIMEOUT_MS"];
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await setSourcePromise;

    expect(mockWorkers).toHaveLength(2);
    expect(mockWorkers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(mockWorkers[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prepare",
        clipId: "mask_video_clip_1",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Mask decoder worker stalled while preparing source; recreating worker",
      expect.any(Error),
    );

    warnSpy.mockRestore();
    player.dispose();
  });

  it("recreates the stalled worker and retries a strict frame after a timeout", async () => {
    mockWorkerPlans.push(
      { prepare: "ready", render: ["hang"] },
      { prepare: "ready", render: ["frame"] },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));
    await vi.runAllTimersAsync();
    await setSourcePromise;

    const renderPromise = player.renderAt(1, { strict: true });

    const timeoutMs = (
      MaskVideoFramePlayer as unknown as Record<string, number>
    )["STRICT_FRAME_TIMEOUT_MS"];
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await renderPromise;

    expect(mockWorkers).toHaveLength(2);
    expect(mockWorkers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(mockWorkers[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prepare",
        clipId: "mask_video_clip_1",
      }),
    );
    expect(mockWorkers[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "render",
        clipId: "mask_video_clip_1",
        strict: true,
        time: 1,
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Mask decoder worker stalled while rendering strict frame; recreating worker",
      expect.any(Error),
    );

    warnSpy.mockRestore();
    player.dispose();
  });

  it("swaps the worker bitmap directly into a Pixi texture", async () => {
    const decodedBitmap = { width: 9, height: 7 };
    const { Texture } = await import("pixi.js");

    mockWorkerPlans.push({
      prepare: "ready",
      render: [{ bitmap: decodedBitmap }],
    });

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));
    await vi.runAllTimersAsync();
    await setSourcePromise;

    const renderPromise = player.renderAt(0.25, { strict: true });
    await vi.runAllTimersAsync();
    await renderPromise;

    expect(Texture.from).toHaveBeenCalledWith(decodedBitmap);
    expect(player.sprite.visible).toBe(true);
    expect(player.sprite.texture.width).toBe(9);
    expect(player.sprite.texture.height).toBe(7);

    player.dispose();
  });
});
