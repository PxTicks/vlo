import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { render, act } from "@testing-library/react";
import { ThumbnailCanvas } from "../ThumbnailCanvas";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import { createMockTimelineView, type MockTimelineView } from "./mockTimelineView";
import { useAsset } from "../../../userAssets";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../../constants";
import { thumbnailCacheService } from "../../services/ThumbnailCacheService";

// Polyfill Symbol.dispose if missing (for 'using' keyword support in tests)
// We must use vi.hoisted to ensure this runs BEFORE the mocks are defined/imported
vi.hoisted(() => {
  if (!Symbol.dispose) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Symbol as any).dispose = Symbol("dispose");
  }
});

// --- Mocks ---

vi.mock("mediabunny", () => {
  return {
    Input: class {
      getPrimaryVideoTrack() {
        return Promise.resolve({
          displayWidth: 1920,
          displayHeight: 1080,
          getFirstTimestamp: () => Promise.resolve(0),
        });
      }
      [Symbol.dispose]() {}
    },
    UrlSource: class {},
    BlobSource: class {},
    VideoSampleSink: class {
      async *samplesAtTimestamps(timestamps: number[]) {
        for (const ts of timestamps) {
          yield {
            timestamp: ts,
            toVideoFrame: () => ({ close: () => {} }),
            [Symbol.dispose]() {},
          };
        }
      }
    },
    ALL_FORMATS: {},
  };
});

vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: vi.fn(),
}));

vi.mock("../../../userAssets", () => ({
  useAsset: vi.fn(),
  ensureAssetSourceLoaded: vi.fn(),
}));

vi.mock("../../hooks/useInteractionStore", () => ({
  useInteractionStore: vi.fn(),
}));

// Mock global ImageBitmap creation
globalThis.createImageBitmap = vi.fn().mockResolvedValue({
  close: vi.fn(),
  width: 100,
  height: 56,
} as ImageBitmap);

describe("ThumbnailCanvas Virtualization", () => {
  let mockContext: {
    fillStyle: string;
    fillRect: Mock;
    drawImage: Mock;
    clearRect: Mock;
  };
  let view: MockTimelineView;

  beforeEach(async () => {
    vi.clearAllMocks();
    thumbnailCacheService.clearAll();

    // 1. Mock Canvas Context
    mockContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockContext as any,
    );

    view = createMockTimelineView();
    vi.mocked(useTimelineViewStore).mockImplementation(view.useStore as never);

    vi.mocked(useAsset).mockReturnValue({
      id: "asset-1",
      type: "video",
      src: "blob:test.mp4",
    } as never);

    const { useInteractionStore } =
      await import("../../hooks/useInteractionStore");

    const mockStore = vi.mocked(useInteractionStore);

    mockStore.mockImplementation((selector) => {
      const state = {
        activeId: null,
        operation: null,
      };
      return selector
        ? selector(state as ReturnType<typeof useInteractionStore.getState>)
        : state;
    });

    mockStore.subscribe = vi.fn(() => () => {});
  });

  afterEach(() => {
    thumbnailCacheService.clearAll();
    vi.restoreAllMocks();
  });

  it("should only render thumbnails within the visible viewport range", async () => {
    // Setup a long clip (e.g., 1 hour) to ensure it extends well beyond the viewport
    const clip = {
      id: "clip-1",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 3600 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 3600 * TICKS_PER_SECOND,
      type: "video",
    };

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );

    // Wait for initial async metadata fetch and draw
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // --- Check 1: Initial Render at scrollLeft = 0 ---
    // Viewport: 0 to 1000px. The published window overscans one viewport on
    // each side, clamped at 0: 0 to 2000px.

    const initialCalls = mockContext.drawImage.mock.calls;
    expect(initialCalls.length).toBeGreaterThan(0);

    const initialXCoords = initialCalls.map((c: unknown[]) => c[1] as number);
    const maxInitialX = Math.max(...initialXCoords);

    // Assert that we are NOT rendering the entire 1-hour clip (which would be huge)
    // We expect rendering to stop around the end of the buffer (2000px)
    // Adding a small margin for slot alignment
    expect(maxInitialX).toBeLessThan(2200);

    // --- Check 2: Scroll Behavior ---
    // Scroll to 5000px
    view.scrollTo(5000);

    await act(async () => {
      // Wait for the throttled fetch
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Get the latest call to drawImage
    const lastCall =
      mockContext.drawImage.mock.calls[
        mockContext.drawImage.mock.calls.length - 1
      ];
    const lastX = lastCall[1];

    // The canvas should implement a sliding window.
    // Viewport is at 5000, so the window is 4000 to 7000px.
    // The internal draw coordinates are relative to the canvas start (0 to 3000).

    expect(lastX).toBeLessThan(3100); // Should be within the local canvas width

    // Verify the canvas position (transform)
    // We need to access the DOM element to check the style
    const canvas = document.getElementById(`thumbnail-canvas-${clip.id}`);
    expect(canvas).toBeTruthy();

    // The transform should be approximately translateX(4000px)
    // allowing for some math variances (floor/ceil)
    const transform = canvas?.style.transform;
    expect(transform).toMatch(/translateX\(calc\(40\d+px/);
  });

  it("redraws only when the visible window moves, not on every scroll", async () => {
    const clip = {
      id: "clip-1",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 3600 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 3600 * TICKS_PER_SECOND,
      type: "video",
    };
    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const canvas = document.getElementById(`thumbnail-canvas-${clip.id}`);
    const transformBefore = canvas?.style.transform;
    mockContext.fillRect.mockClear();

    // Still inside the window's margin: the canvas already covers it.
    view.scrollTo(400);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockContext.fillRect).not.toHaveBeenCalled();
    expect(canvas?.style.transform).toBe(transformBefore);

    view.scrollTo(1500);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockContext.fillRect).toHaveBeenCalled();
    expect(canvas?.style.transform).not.toBe(transformBefore);
  });

  it("should not render anything if the clip is completely offscreen", async () => {
    const clip = {
      id: "clip-1",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND, // Short clip
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      type: "video",
    };

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );

    // Move viewport far away from the clip
    view.scrollTo(5000);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Clear previous calls from initial mount
    mockContext.drawImage.mockClear();

    // Trigger a redraw attempt with another window move
    view.scrollTo(9000);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Should not draw anything because clip (at 0) is far from viewport (at 5000)
    expect(mockContext.drawImage).not.toHaveBeenCalled();
  });

  it("does no probing or context work for an off-screen clip until it scrolls into view", async () => {
    // Long timelines mount hundreds of off-screen clips; each used to probe
    // its source and hold a 2D context on mount and on every scroll event.
    const startSeconds = 600;
    const clipStartPx = startSeconds * PIXELS_PER_SECOND;
    const clip = {
      id: "clip-far",
      assetId: "asset-1",
      start: startSeconds * TICKS_PER_SECOND,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      type: "video",
    };
    const loadMetadata = vi.spyOn(thumbnailCacheService, "loadMetadata");
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(loadMetadata).not.toHaveBeenCalled();
    expect(getContext).not.toHaveBeenCalled();

    view.scrollTo(clipStartPx - 200);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(loadMetadata).toHaveBeenCalledTimes(1);
    expect(mockContext.drawImage).toHaveBeenCalled();
  });

  it("probes a video whose cached metadata lacks a first timestamp", async () => {
    thumbnailCacheService.acquire("asset-1");
    thumbnailCacheService.setMetadata("asset-1", { aspectRatio: 2 });
    const loadMetadata = vi.spyOn(thumbnailCacheService, "loadMetadata");
    const clip = {
      id: "clip-partial",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      type: "video",
    };

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(loadMetadata).toHaveBeenCalledTimes(1);
    // The cached aspect ratio is kept; the probe fills in the timestamp.
    expect(thumbnailCacheService.getMetadata("asset-1")).toEqual({
      aspectRatio: 2,
      firstTimestampSeconds: 0,
    });
  });

  it("pre-renders image thumbnails beyond the initial clip duration for live extension", async () => {
    vi.mocked(useAsset).mockReturnValue({
      id: "asset-1",
      type: "image",
      src: "test.png",
    } as never);

    thumbnailCacheService.acquire("asset-1");
    thumbnailCacheService.setMetadata("asset-1", { aspectRatio: 2 });
    thumbnailCacheService.setThumbnail("asset-1", "image_base", {
      width: 200,
      height: 100,
      close: vi.fn(),
    } as ImageBitmap);

    const clip = {
      id: "clip-image-1",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND, // 1000px visible
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND, // no extra finite media on the right
      sourceDuration: null, // unbounded still image
      type: "image",
      transformations: [],
      name: "image",
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
    };

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const imageDrawCalls = mockContext.drawImage.mock.calls.filter(
      (call: unknown[]) => call.length >= 9,
    );
    expect(imageDrawCalls.length).toBeGreaterThan(0);

    // drawX for the 9-arg image drawImage signature is argument index 5.
    const maxDrawX = Math.max(
      ...imageDrawCalls.map((call: unknown[]) => Number(call[5])),
    );

    // Without right pre-render wing, this would stay around clip width (~1000px).
    expect(maxDrawX).toBeGreaterThan(1100);
  });
});
