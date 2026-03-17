// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Application, Container } from "pixi.js";
import { useTrackRenderEngine } from "../useTrackRenderEngine";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import type { Asset } from "../../../../types/Asset";
import { TrackRenderEngine } from "../../services/TrackRenderEngine";
import type { GenericFilterTransform } from "../../../transformations";

// --- Mocks Setup ---

// 1. Mock Worker — must be in vi.hoisted so it's available when vi.mock factories run
const {
  mockTimelineState,
  mockAssetState,
  mockPlaybackState,
  mockPlaybackFrameState,
  mockPlayerState,
  mockWorkerInstances,
  mockSprite,
  MockWorker,
} = vi.hoisted(() => {
  const instances: Array<{
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];

  class MockWorkerClass {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();

    constructor() {
      instances.push(this);
    }
  }

  return {
    mockTimelineState: {
      clips: [] as TimelineClip[],
      selectedClipIds: [] as string[],
    },
    mockAssetState: { assets: [] as Asset[] },
    mockPlaybackState: {
      time: 0,
      subscriber: null as ((time: number) => void) | null,
    },
    mockPlaybackFrameState: {
      time: 0,
      subscriber: null as ((time: number) => void) | null,
    },
    mockPlayerState: {
      isPlaying: false,
    },
    mockWorkerInstances: instances,
    mockSprite: {
      anchor: { set: vi.fn() },
      zIndex: 0,
      texture: null as unknown,
      visible: true,
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      eventMode: "passive" as unknown,
      cursor: "default" as unknown,
      scale: { x: 1, y: 1 },
      rotation: 0,
      position: { x: 0, y: 0 },
      getGlobalPosition: vi.fn(() => ({ x: 0, y: 0 })),
      setMask: vi.fn(),
      addChild: vi.fn(),
    },
    MockWorker: MockWorkerClass,
  };
});

vi.stubGlobal("Worker", MockWorker);

vi.mock("../../workers/decoder.worker?worker", () => ({
  default: MockWorker,
}));

// 2. Mock PIXI
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
      EMPTY: { destroy: vi.fn() },
    },
    Sprite: class {
      constructor() {
        return mockSprite;
      }
    },
    Container: class {
      children: unknown[] = [];
      zIndex = 0;
      effects: unknown[] = [];
      mask: unknown = null;
      addChild = vi.fn((child) => this.children.push(child));
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
      destroy = vi.fn();
      removeFromParent = vi.fn();
      on = vi.fn();
      off = vi.fn();
      sortChildren = vi.fn();
    },
    Application: vi.fn(),
  };
});

// 3. Mock Transformations
vi.mock("../../../transformations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../transformations")>();
  return {
    ...actual,
    applyClipTransforms: vi.fn(),
  };
});

// 4. Mock Stores
vi.mock("../../../timeline/useTimelineStore", () => ({
  useTimelineStore: (
    selector: (state: {
      clips: TimelineClip[];
      selectedClipIds: string[];
    }) => unknown,
  ) => selector(mockTimelineState),
}));

vi.mock("../../../userAssets", () => ({
  useAssetStore: (selector: (state: { assets: Asset[] }) => unknown) =>
    selector(mockAssetState),
}));

vi.mock("../../../player/services/PlaybackClock", () => ({
  playbackClock: {
    get time() {
      return mockPlaybackState.time;
    },
    subscribe: (cb: (time: number) => void) => {
      mockPlaybackState.subscriber = cb;
      return vi.fn();
    },
  },
  playbackFrameClock: {
    get time() {
      return mockPlaybackFrameState.time;
    },
    subscribe: (cb: (time: number) => void) => {
      mockPlaybackFrameState.subscriber = cb;
      return vi.fn();
    },
  },
}));

vi.mock("../../../player/usePlayerStore", () => ({
  usePlayerStore: (selector: (state: { isPlaying: boolean }) => unknown) =>
    selector(mockPlayerState),
}));

// Mock App
const mockApp = {
  stage: {
    addChild: vi.fn(),
    removeChild: vi.fn(),
    sortChildren: vi.fn(),
    sortableChildren: false,
    on: vi.fn(),
    off: vi.fn(),
  },
  renderer: {
    width: 800,
    height: 600,
    events: {},
  },
  ticker: {
    add: vi.fn(),
    remove: vi.fn(),
  },
} as unknown as Application;

describe("useTrackRenderEngine Integration", () => {
  const mockViewportHandlers = new Map<string, () => void>();

  beforeEach(() => {
    mockWorkerInstances.length = 0;
    mockTimelineState.clips = [];
    mockTimelineState.selectedClipIds = [];
    mockAssetState.assets = [];
    mockPlaybackState.subscriber = null;
    mockPlaybackState.time = 0;
    mockPlaybackFrameState.subscriber = null;
    mockPlaybackFrameState.time = 0;
    mockPlayerState.isPlaying = false;
    mockSprite.visible = true;
    mockSprite.texture = null;
    mockSprite.scale.x = 1;
    mockSprite.scale.y = 1;
    mockSprite.rotation = 0;
    mockViewportHandlers.clear();
    vi.clearAllMocks();
  });

  const mockContainer = {
    addChild: vi.fn(),
    removeChild: vi.fn(),
    sortChildren: vi.fn(),
    sortableChildren: false,
    children: [],
    on: vi.fn((event: string, handler: () => void) => {
      mockViewportHandlers.set(event, handler);
      return mockContainer;
    }),
    off: vi.fn((event: string) => {
      mockViewportHandlers.delete(event);
      return mockContainer;
    }),
  } as unknown as Container;

  it("initializes without crashing", () => {
    const { result, unmount } = renderHook(() =>
      useTrackRenderEngine("track-1", mockApp, mockContainer, 1, {
        width: 800,
        height: 600,
      }),
    );
    expect(result.current.spriteInstance).toBeDefined();
    unmount();
  });

  it("should NOT show stale frame when returning to a clip after scrubbing", async () => {
    const trackId = "track-1";
    const clipId = "clip-A";

    // Setup state
    mockTimelineState.clips = [
      {
        id: clipId,
        trackId: trackId,
        assetId: "asset-A",
        name: "Test Clip",
        start: 1.0 * TICKS_PER_SECOND,
        timelineDuration: 4.0 * TICKS_PER_SECOND,
        sourceDuration: 10.0 * TICKS_PER_SECOND,
        transformedDuration: 10.0 * TICKS_PER_SECOND,
        transformedOffset: 0,
        croppedSourceDuration: 10.0 * TICKS_PER_SECOND,
        offset: 0,
        type: "video",
        transformations: [],
      },
    ];
    mockAssetState.assets = [
      {
        id: "asset-A",
        src: "test.mp4",
        name: "Test Asset",
        hash: "abc123hash",
        type: "video",

        createdAt: 0,
      },
    ];

    const { unmount } = renderHook(() =>
      useTrackRenderEngine(trackId, mockApp, mockContainer, 1, {
        width: 800,
        height: 600,
      }),
    );

    // 1. Advance to middle of clip (e.g. time = 2.0)
    act(() => {
      mockPlaybackState.time = 2.0 * TICKS_PER_SECOND;
      if (mockPlaybackState.subscriber)
        mockPlaybackState.subscriber(2.0 * TICKS_PER_SECOND);
    });

    // Verify worker got render request
    const worker = mockWorkerInstances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "render",
        clipId: clipId,
      }),
    );

    // 2. Simulate Worker responding with a frame
    const mockBitmap = { width: 100, height: 100, close: vi.fn() };

    await act(async () => {
      if (worker.onmessage) {
        worker.onmessage({
          data: {
            type: "frame",
            clipId: clipId,
            bitmap: mockBitmap,
          },
        } as MessageEvent);
      }
      await Promise.resolve();
    });

    // Assert: Sprite is visible and has a texture
    expect(mockSprite.visible).toBe(true);
    expect(mockSprite.texture).not.toBeNull();

    // 3. Scrub to BEFORE the clip (e.g. time = 0.5)
    act(() => {
      mockPlaybackState.time = 0.5 * TICKS_PER_SECOND;
      mockPlaybackState.subscriber!(0.5 * TICKS_PER_SECOND);
    });

    // Assert: Sprite should be hidden
    expect(mockSprite.visible).toBe(false);

    // 4. Scrub BACK to start of clip (e.g. time = 1.0)
    act(() => {
      mockPlaybackState.time = 1.0 * TICKS_PER_SECOND;
      mockPlaybackState.subscriber!(1.0 * TICKS_PER_SECOND);
    });

    // BUG CHECK: The sprite should NOT be visible yet (should wait for frame).
    // This assertion passed previously only after the fix.
    expect(mockSprite.visible).toBe(false);

    act(() => {
      worker.onmessage?.({
        data: {
          type: "frame",
          clipId,
          bitmap: { width: 100, height: 100, close: vi.fn() },
        },
      } as MessageEvent);
    });

    unmount();
  });

  it("registers a synchronized renderer for paused scrubbing when orchestrated", async () => {
    const trackId = "track-1";
    const clipId = "clip-A";
    const registeredRenderers = new Map<string, (time: number) => Promise<void>>();

    mockTimelineState.clips = [
      {
        id: clipId,
        trackId,
        assetId: "asset-A",
        name: "Test Clip",
        start: 0,
        timelineDuration: 10 * TICKS_PER_SECOND,
        sourceDuration: 10 * TICKS_PER_SECOND,
        transformedDuration: 10 * TICKS_PER_SECOND,
        transformedOffset: 0,
        croppedSourceDuration: 10 * TICKS_PER_SECOND,
        offset: 0,
        type: "video",
        transformations: [],
      },
    ];
    mockAssetState.assets = [
      {
        id: "asset-A",
        src: "test.mp4",
        name: "Test Asset",
        hash: "abc123hash",
        type: "video",
        createdAt: 0,
      },
    ];

    const { unmount } = renderHook(() =>
      useTrackRenderEngine(
        trackId,
        mockApp,
        mockContainer,
        1,
        {
          width: 800,
          height: 600,
        },
        (registeredTrackId, renderer) => {
          if (renderer) {
            registeredRenderers.set(registeredTrackId, renderer);
            return;
          }
          registeredRenderers.delete(registeredTrackId);
        },
      ),
    );

    expect(mockPlaybackState.subscriber).toBeNull();

    const playbackRenderer = registeredRenderers.get(trackId);
    expect(playbackRenderer).toBeTypeOf("function");

    const worker = mockWorkerInstances[0];
    const initialRenderCount = worker.postMessage.mock.calls.filter(
      ([message]) => message.type === "render",
    ).length;

    let renderPromise: Promise<void> | undefined;
    await act(async () => {
      renderPromise = playbackRenderer?.(2 * TICKS_PER_SECOND);
      await Promise.resolve();
    });

    const renderCountAfterPlaybackRender = worker.postMessage.mock.calls.filter(
      ([message]) => message.type === "render",
    ).length;
    expect(renderCountAfterPlaybackRender).toBeGreaterThan(initialRenderCount);

    await act(async () => {
      worker.onmessage?.({
        data: {
          type: "frame",
          clipId,
          bitmap: { width: 100, height: 100, close: vi.fn() },
        },
      } as MessageEvent);
      await renderPromise;
    });

    unmount();
    expect(registeredRenderers.has(trackId)).toBe(false);
  });

  it("refreshes the paused synchronized frame when clip transforms change", async () => {
    const trackId = "track-1";
    const clipId = "clip-A";
    const registeredRenderers = new Map<
      string,
      (time: number) => Promise<void>
    >();
    const renderSpy = vi.spyOn(
      TrackRenderEngine.prototype,
      "renderSynchronizedPlaybackFrame",
    );

    const initialFilterTransforms: GenericFilterTransform[] = [
      {
        id: "hsl-1",
        type: "filter",
        filterName: "HslAdjustmentFilter",
        isEnabled: true,
        parameters: {
          hue: 0,
        },
      },
    ];
    mockPlaybackState.time = 2 * TICKS_PER_SECOND;
    mockTimelineState.clips = [
      {
        id: clipId,
        trackId,
        assetId: "asset-A",
        name: "Test Clip",
        start: 0,
        timelineDuration: 10 * TICKS_PER_SECOND,
        sourceDuration: 10 * TICKS_PER_SECOND,
        transformedDuration: 10 * TICKS_PER_SECOND,
        transformedOffset: 0,
        croppedSourceDuration: 10 * TICKS_PER_SECOND,
        offset: 0,
        type: "video",
        transformations: initialFilterTransforms,
      },
    ];
    mockAssetState.assets = [
      {
        id: "asset-A",
        src: "test.mp4",
        name: "Test Asset",
        hash: "abc123hash",
        type: "video",
        createdAt: 0,
      },
    ];

    const { rerender, unmount } = renderHook(() =>
      useTrackRenderEngine(
        trackId,
        mockApp,
        mockContainer,
        1,
        {
          width: 800,
          height: 600,
        },
        (registeredTrackId, renderer) => {
          if (renderer) {
            registeredRenderers.set(registeredTrackId, renderer);
            return;
          }
          registeredRenderers.delete(registeredTrackId);
        },
      ),
    );

    const playbackRenderer = registeredRenderers.get(trackId);
    expect(playbackRenderer).toBeTypeOf("function");

    const worker = mockWorkerInstances[0];
    let renderPromise: Promise<void> | undefined;
    await act(async () => {
      renderPromise = playbackRenderer?.(mockPlaybackState.time);
      await Promise.resolve();
    });

    await act(async () => {
      worker.onmessage?.({
        data: {
          type: "frame",
          clipId,
          bitmap: { width: 100, height: 100, close: vi.fn() },
          transformTime: mockPlaybackState.time,
        },
      } as MessageEvent);
      await renderPromise;
    });

    renderSpy.mockClear();

    const updatedFilterTransforms: GenericFilterTransform[] = [
      {
        id: "hsl-1",
        type: "filter",
        filterName: "HslAdjustmentFilter",
        isEnabled: true,
        parameters: {
          hue: 42,
        },
      },
    ];
    mockTimelineState.clips = [
      {
        ...mockTimelineState.clips[0],
        transformations: updatedFilterTransforms,
      },
    ];

    await act(async () => {
      rerender();
    });

    await waitFor(() => {
      expect(renderSpy).toHaveBeenCalledWith(
        mockPlaybackState.time,
        expect.arrayContaining([
          expect.objectContaining({
            id: clipId,
            transformations: [
              expect.objectContaining({
                id: "hsl-1",
                parameters: expect.objectContaining({
                  hue: 42,
                }),
              }),
            ],
          }),
        ]),
        expect.any(Map),
        expect.arrayContaining([
          expect.objectContaining({
            id: "asset-A",
          }),
        ]),
        { width: 800, height: 600 },
        expect.objectContaining({
          fps: expect.any(Number),
        }),
      );
    });

    unmount();
  });

  it("registers a synchronized playback renderer during live playback", async () => {
    const trackId = "track-1";
    const clipId = "clip-A";
    mockPlayerState.isPlaying = true;
    const registeredRenderers = new Map<string, (time: number) => Promise<void>>();

    mockTimelineState.clips = [
      {
        id: clipId,
        trackId,
        assetId: "asset-A",
        name: "Test Clip",
        start: 0,
        timelineDuration: 10 * TICKS_PER_SECOND,
        sourceDuration: 10 * TICKS_PER_SECOND,
        transformedDuration: 10 * TICKS_PER_SECOND,
        transformedOffset: 0,
        croppedSourceDuration: 10 * TICKS_PER_SECOND,
        offset: 0,
        type: "video",
        transformations: [],
      },
    ];
    mockAssetState.assets = [
      {
        id: "asset-A",
        src: "test.mp4",
        name: "Test Asset",
        hash: "abc123hash",
        type: "video",
        createdAt: 0,
      },
    ];

    const { unmount } = renderHook(() =>
      useTrackRenderEngine(
        trackId,
        mockApp,
        mockContainer,
        1,
        {
          width: 800,
          height: 600,
        },
        (registeredTrackId, renderer) => {
          if (renderer) {
            registeredRenderers.set(registeredTrackId, renderer);
            return;
          }
          registeredRenderers.delete(registeredTrackId);
        },
      ),
    );

    const worker = mockWorkerInstances[0];
    expect(mockPlaybackState.subscriber).toBeNull();
    expect(mockPlaybackFrameState.subscriber).toBeNull();

    const playbackRenderer = registeredRenderers.get(trackId);
    expect(playbackRenderer).toBeTypeOf("function");

    const initialRenderCount = worker.postMessage.mock.calls.filter(
      ([message]) => message.type === "render",
    ).length;

    let renderPromise: Promise<void> | undefined;
    await act(async () => {
      renderPromise = playbackRenderer?.(TICKS_PER_SECOND / 30);
      await Promise.resolve();
    });

    const renderCountAfterPlaybackRender = worker.postMessage.mock.calls.filter(
      ([message]) => message.type === "render",
    ).length;
    expect(renderCountAfterPlaybackRender).toBeGreaterThan(initialRenderCount);

    await act(async () => {
      worker.onmessage?.({
        data: {
          type: "frame",
          clipId,
          bitmap: { width: 100, height: 100, close: vi.fn() },
        },
      } as MessageEvent);
      await renderPromise;
    });

    unmount();
    expect(registeredRenderers.has(trackId)).toBe(false);
  });

  it("refreshes paused transforms when the viewport camera zooms or moves", async () => {
    const trackId = "track-1";
    const clipId = "clip-A";
    const forceUpdateSpy = vi.spyOn(
      TrackRenderEngine.prototype,
      "forceUpdateTransforms",
    );

    mockPlaybackState.time = 2 * TICKS_PER_SECOND;
    mockTimelineState.clips = [
      {
        id: clipId,
        trackId,
        assetId: "asset-A",
        name: "Test Clip",
        start: 0,
        timelineDuration: 10 * TICKS_PER_SECOND,
        sourceDuration: 10 * TICKS_PER_SECOND,
        transformedDuration: 10 * TICKS_PER_SECOND,
        transformedOffset: 0,
        croppedSourceDuration: 10 * TICKS_PER_SECOND,
        offset: 0,
        type: "video",
        transformations: [],
      },
    ];
    mockAssetState.assets = [
      {
        id: "asset-A",
        src: "test.mp4",
        name: "Test Asset",
        hash: "abc123hash",
        type: "video",
        createdAt: 0,
      },
    ];

    const { unmount } = renderHook(() =>
      useTrackRenderEngine(trackId, mockApp, mockContainer, 1, {
        width: 800,
        height: 600,
      }),
    );

    act(() => {
      mockPlaybackState.subscriber?.(mockPlaybackState.time);
    });

    forceUpdateSpy.mockClear();

    await act(async () => {
      mockViewportHandlers.get("zoomed")?.();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(forceUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: clipId }),
      { width: 800, height: 600 },
      mockPlaybackState.time,
      [],
      expect.any(Map),
    );

    unmount();
  });
});
