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
import type { TimelineViewState } from "../../hooks/useTimelineViewStore";
import { useAsset } from "../../../userAssets";
import { TICKS_PER_SECOND } from "../../constants";
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
  let mockScrollContainer: Partial<HTMLElement> & {
    addEventListener: Mock;
    removeEventListener: Mock;
  };
  let scrollListener: EventListener | null = null;

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

    // 2. Mock Scroll Container
    mockScrollContainer = {
      scrollLeft: 0,
      clientWidth: 1000, // Viewport width of 1000px
      addEventListener: vi.fn((event, handler) => {
        if (event === "scroll") scrollListener = handler as EventListener;
      }),
      removeEventListener: vi.fn(),
    };

    // 3. Setup Store Mocks
    vi.mocked(useTimelineViewStore).mockImplementation(
      (selector: (state: TimelineViewState) => unknown) => {
        const state = {
          scrollContainer: mockScrollContainer as unknown as HTMLElement,
          zoomScale: 1,
          setZoomScale: vi.fn(),
          ticksToPx: (ticks: number) => ticks,
          pxToTicks: (px: number) => px,
          setScrollContainer: vi.fn(),
        };
        return selector ? selector(state) : state;
      },
    );

    vi.mocked(useAsset).mockReturnValue({
      id: "asset-1",
      type: "video",
      src: "test.mp4",
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
          clip as unknown as import("../../../../types/TimelineTypes").BaseClip
        }
      />,
    );

    // Wait for initial async metadata fetch and draw
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // --- Check 1: Initial Render at scrollLeft = 0 ---
    // Viewport: 0 to 1000px
    // Buffer: 50% of 1000px = 500px
    // Expected Render Range: -500px to 1500px
    // Since clip starts at 0, we expect draws from 0 to ~1500px.

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
    mockScrollContainer.scrollLeft = 5000;

    await act(async () => {
      if (scrollListener) scrollListener(new Event("scroll"));
      // Wait for debounce (150ms in hook)
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Get the latest call to drawImage
    const lastCall =
      mockContext.drawImage.mock.calls[
        mockContext.drawImage.mock.calls.length - 1
      ];
    const lastX = lastCall[1];

    // The canvas should implement a sliding window.
    // viewport is at 5000. Buffer is 500.
    // The canvas should be positioned around 4500.
    // The internal draw coordinates should be relative to the canvas start (0 to ~2000).

    expect(lastX).toBeLessThan(3100); // Should be within the local canvas width

    // Verify the canvas position (transform)
    // We need to access the DOM element to check the style
    const canvas = document.getElementById(`thumbnail-canvas-${clip.id}`);
    expect(canvas).toBeTruthy();

    // The transform should be approximately translateX(4500px)
    // allowing for some math variances (floor/ceil)
    const transform = canvas?.style.transform;
    expect(transform).toMatch(/translateX\(calc\(40\d+px/);
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
          clip as unknown as import("../../../../types/TimelineTypes").BaseClip
        }
      />,
    );

    // Move viewport far away from the clip
    mockScrollContainer.scrollLeft = 5000;

    // Trigger scroll update
    await act(async () => {
      if (scrollListener) scrollListener(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Clear previous calls from initial mount
    mockContext.drawImage.mockClear();

    // Trigger a redraw attempt (e.g. via another scroll or update)
    await act(async () => {
      if (scrollListener) scrollListener(new Event("scroll"));
    });

    // Should not draw anything because clip (at 0) is far from viewport (at 5000)
    expect(mockContext.drawImage).not.toHaveBeenCalled();
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
          clip as unknown as import("../../../../types/TimelineTypes").BaseClip
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
