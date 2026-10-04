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
import { createMockTimelineView } from "./mockTimelineView";
import { useAsset } from "../../../userAssets";
import { TICKS_PER_SECOND } from "../../constants";
import * as TimeCalculation from "../../../transformations";

// Polyfill Symbol.dispose
vi.hoisted(() => {
  if (!Symbol.dispose) {
    (Symbol as { dispose?: symbol }).dispose = Symbol("dispose");
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

// Mock calculateClipTime to verify it's called
vi.mock("../../../transformations", () => ({
  calculateClipTime: vi.fn((_clip, time) => time * 2), // Mock 2x speed (source time = 2 * visual time)
}));

globalThis.createImageBitmap = vi.fn().mockResolvedValue({
  close: vi.fn(),
  width: 100,
  height: 56,
} as ImageBitmap);

describe("ThumbnailCanvas Speed Ramp", () => {
  let mockContext: {
    fillStyle: string;
    fillRect: Mock;
    drawImage: Mock;
    clearRect: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        mockContext as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );

    vi.mocked(useTimelineViewStore).mockImplementation(
      createMockTimelineView().useStore as never,
    );

    vi.mocked(useAsset).mockReturnValue({
      id: "asset-1",
      type: "video",
      src: "blob:test.mp4",
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call calculateClipTime when rendering thumbnails", async () => {
    const clip = {
      id: "clip-ramp",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      type: "video",
      // Add fake transformation to trigger logic if any check exists
      transformations: [
        { id: "t1", type: "speed", isEnabled: true, parameters: { factor: 2 } },
      ],
    };

    render(
      <ThumbnailCanvas
        clip={
          clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip
        }
      />,
    );

    // Wait for effect
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Check if calculateClipTime was called
    // It should be called for each slot in the visible range
    expect(TimeCalculation.calculateClipTime).toHaveBeenCalled();

    // We can even match the arguments if we want to be precise
    // (clip, tickDelta)
    expect(TimeCalculation.calculateClipTime).toHaveBeenCalledWith(
      expect.objectContaining({ id: "clip-ramp" }),
      expect.any(Number),
    );
  });
});
