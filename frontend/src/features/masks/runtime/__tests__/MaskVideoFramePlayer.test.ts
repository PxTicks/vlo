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
        requestId?: string;
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
              requestId: message.requestId,
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
    name: `${id}.mp4`,
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

  it("supersedes overlapping strict frame requests", async () => {
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

    await vi.runAllTimersAsync();
    await Promise.all([firstRender, secondRender]);

    const renderMessagesAfterResolve = worker.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === "render");
    expect(renderMessagesAfterResolve).toHaveLength(1);

    player.dispose();
  });

  it("does not recreate the worker after a first source preparation timeout", async () => {
    mockWorkerPlans.push({ prepare: "hang" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));

    const timeoutMs = (
      MaskVideoFramePlayer as unknown as Record<string, number>
    )["SOURCE_PREPARE_TIMEOUT_MS"];
    const rejection = expect(setSourcePromise).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await rejection;

    expect(mockWorkers).toHaveLength(1);
    expect(mockWorkers[0]?.terminate).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    player.dispose();
  });

  it("recreates the worker after consecutive source preparation timeouts", async () => {
    mockWorkerPlans.push({ prepare: "hang" }, { prepare: "ready" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const player = new MaskVideoFramePlayer("clip_1");
    const asset = createMaskAsset("mask_asset");
    const firstSetSource = player.setSource(asset);

    const timeoutMs = (
      MaskVideoFramePlayer as unknown as Record<string, number>
    )["SOURCE_PREPARE_TIMEOUT_MS"];
    const firstRejection = expect(firstSetSource).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await firstRejection;

    const secondSetSource = player.setSource(asset);
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await secondSetSource;

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

  it("does not recreate the worker after a first strict frame timeout", async () => {
    mockWorkerPlans.push(
      { prepare: "ready", render: ["hang"] },
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
    const rejection = expect(renderPromise).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await rejection;

    expect(mockWorkers).toHaveLength(1);
    expect(mockWorkers[0]?.terminate).not.toHaveBeenCalled();
    expect(mockWorkers[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "render",
        clipId: "mask_video_clip_1",
        strict: true,
        time: 1,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    player.dispose();
  });

  it("recreates the worker after consecutive strict frame timeouts", async () => {
    mockWorkerPlans.push(
      { prepare: "ready", render: ["hang", "hang"] },
      { prepare: "ready", render: ["frame"] },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));
    await vi.runAllTimersAsync();
    await setSourcePromise;

    const timeoutMs = (
      MaskVideoFramePlayer as unknown as Record<string, number>
    )["STRICT_FRAME_TIMEOUT_MS"];
    const firstRender = player.renderAt(1, { strict: true });
    const firstRejection = expect(firstRender).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await firstRejection;

    const secondRender = player.renderAt(2, { strict: true });
    await vi.advanceTimersByTimeAsync(timeoutMs + 20);
    await vi.runAllTimersAsync();
    await secondRender;

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
        time: 2,
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

  it("ignores a stale preview frame while waiting for a strict frame", async () => {
    mockWorkerPlans.push({
      prepare: "ready",
      render: [
        { bitmap: { width: 3, height: 3 } },
        { bitmap: { width: 9, height: 7 } },
      ],
    });

    const player = new MaskVideoFramePlayer("clip_1");
    const setSourcePromise = player.setSource(createMaskAsset("mask_asset"));
    await vi.runAllTimersAsync();
    await setSourcePromise;

    void player.renderAt(0.25);
    const strictRenderPromise = player.renderAt(0.5, { strict: true });
    await vi.runAllTimersAsync();
    await strictRenderPromise;

    expect(player.sprite.visible).toBe(true);
    expect(player.sprite.texture.width).toBe(9);
    expect(player.sprite.texture.height).toBe(7);

    player.dispose();
  });
});
