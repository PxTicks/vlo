import { TrackRenderEngine } from "../TrackRenderEngine";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";
import { applyClipTransforms } from "../../../transformations";

// Mock PixiJS
vi.mock("pixi.js", async () => {
  return {
    Container: class MockContainer {
      addChild = vi.fn();
      pluginName = "";
      zIndex = 0;
      destroy = vi.fn();
      removeFromParent = vi.fn();
    },
    Sprite: class MockSprite {
      anchor = { set: vi.fn() };
      texture = { destroy: vi.fn() };
      visible = false;
      destroy = vi.fn();
      setMask = vi.fn();
      addChild = vi.fn();
    },
    Texture: {
      from: vi.fn(() => ({ destroy: vi.fn() })),
      EMPTY: "empty",
    },
  };
});

// Mock Worker
vi.mock("../../workers/decoder.worker?worker", () => {
  return {
    default: class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage = vi.fn((msg) => {
        // Auto-reply for strict render requests
        if (msg.type === "render" && msg.strict && this.onmessage) {
          // Simulate async response
          setTimeout(() => {
            this.onmessage!({
              data: {
                type: "frame",
                bitmap: {}, // Mock bitmap
                clipId: msg.clipId,
                transformTime: msg.transformTime,
              },
            } as MessageEvent);
          }, 0);
        }
      });
      terminate = vi.fn();
    },
  };
});

// Mock applyClipTransforms
vi.mock("../../../transformations", () => ({
  applyClipTransforms: vi.fn(),
}));

describe("TrackRenderEngine Time Units", () => {
  let engine: TrackRenderEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new TrackRenderEngine(0);
  });

  it("should pass consistent time units (Ticks) to applyClipTransforms during export", async () => {
    const dummyClip: TimelineClip = {
      id: "c1",
      trackId: "t1",
      assetId: "a1",
      start: 1000,
      timelineDuration: 5000,
      offset: 0,
      type: "video",
    } as TimelineClip; // Cast to avoid missing property errors in test
    const dummyAsset: Asset = {
      id: "a1",
      src: "test.mp4",
      type: "video",
    } as Asset;
    const dimensions = { width: 1920, height: 1080 };

    // 1. Simulate render loop at time 2000 ticks
    const currentTime = 2000;

    // Expected Raw Time (Ticks): 2000 - 1000 = 1000
    const expectedRawTime = 1000;

    // A. Call Update (Live Loop Logic)
    engine.update(
      currentTime,
      [dummyClip],
      new Map(),
      [dummyAsset],
      dimensions,
      { shouldRender: false },
    );

    // B. Call RenderFrame (Export Logic)
    await engine.renderFrame(currentTime, dummyClip, dimensions);

    // Analyze calls to applyClipTransforms
    const calls = vi.mocked(applyClipTransforms).mock.calls;

    // We expect at least one call from renderFrame (when texture updates)
    expect(calls.length).toBeGreaterThan(0);

    calls.forEach((call: unknown[]) => {
      const passedTime = call[3] as number; // 4th argument is time
      // We expect 1000 (Ticks)
      expect(passedTime).toBeCloseTo(expectedRawTime, 0.1);
    });
  });
});
