import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ThumbnailCanvas } from "../ThumbnailCanvas";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import type { TimelineViewState } from "../../hooks/useTimelineViewStore";
import { AudioAnalysisService, useAsset } from "../../../userAssets";
import type { Input, InputAudioTrack, WrappedAudioBuffer } from "mediabunny";
import { TICKS_PER_SECOND } from "../../constants";
import { waveformCacheService } from "../../services/WaveformCacheService";

function createWrappedAudioBuffer(
  timestamp: number,
  channelData: readonly number[][],
): WrappedAudioBuffer {
  const length = channelData[0]?.length ?? 0;
  return {
    timestamp,
    duration: length / mockAudioState.sampleRate,
    buffer: {
      sampleRate: mockAudioState.sampleRate,
      numberOfChannels: channelData.length,
      length,
      getChannelData: (channel: number) =>
        Float32Array.from(channelData[channel] ?? []),
    } as unknown as AudioBuffer,
  };
}

const mockAudioState = vi.hoisted(() => ({
  canDecode: true,
  durationSeconds: 5,
  firstTimestampSeconds: 0,
  lastSamplesRequest: null as { end: number; start: number } | null,
  numberOfChannels: 1,
  sampleRate: 48_000,
  buffers: [] as WrappedAudioBuffer[],
}));

function createTestAudioAnalysisService(): AudioAnalysisService {
  const track = {
    get sampleRate() {
      return mockAudioState.sampleRate;
    },
    get numberOfChannels() {
      return mockAudioState.numberOfChannels;
    },
    canDecode: vi.fn(async () => mockAudioState.canDecode),
    computeDuration: vi.fn(async () => mockAudioState.durationSeconds),
    getFirstTimestamp: vi.fn(async () => mockAudioState.firstTimestampSeconds),
  } as unknown as InputAudioTrack;
  const input = {
    getPrimaryAudioTrack: vi.fn(async () => track),
  } as unknown as Input;
  return new AudioAnalysisService({
    getInput: async () => input,
    createSink: () => ({
      buffers: async function* (start: number, end: number) {
        mockAudioState.lastSamplesRequest = { start, end };
        for (const buffer of mockAudioState.buffers) yield buffer;
      },
    }),
  });
}

vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: vi.fn(),
}));

vi.mock("../../../userAssets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../userAssets")>();
  return { ...actual, useAsset: vi.fn() };
});

vi.mock("../../hooks/useInteractionStore", () => ({
  useInteractionStore: vi.fn(),
}));

describe("WaveformCanvas", () => {
  let mockContext: {
    clearRect: Mock;
    drawImage: Mock;
    fillRect: Mock;
    fillStyle: string;
  };
  let mockScrollContainer: Partial<HTMLElement> & {
    addEventListener: Mock;
    removeEventListener: Mock;
  };
  let scrollListener: EventListener | null = null;
  let audioAnalysis: AudioAnalysisService;

  beforeEach(async () => {
    vi.clearAllMocks();
    waveformCacheService.clearAll();

    mockAudioState.canDecode = true;
    mockAudioState.durationSeconds = 5;
    mockAudioState.firstTimestampSeconds = 0;
    mockAudioState.lastSamplesRequest = null;
    mockAudioState.numberOfChannels = 1;
    mockAudioState.sampleRate = 48_000;
    mockAudioState.buffers = [
      createWrappedAudioBuffer(0, [
        Array.from({ length: 2048 }, (_, index) =>
          index % 2 === 0 ? 0.8 : -0.8,
        ),
      ]),
    ];
    audioAnalysis = createTestAudioAnalysisService();

    mockContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockContext as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );

    mockScrollContainer = {
      scrollLeft: 0,
      clientWidth: 1000,
      addEventListener: vi.fn((event, handler) => {
        if (event === "scroll") {
          scrollListener = handler as EventListener;
        }
      }),
      removeEventListener: vi.fn(),
    };

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
      type: "audio",
      src: "blob:test.wav",
    } as never);

    const { useInteractionStore } =
      await import("../../hooks/useInteractionStore");
    const mockStore = vi.mocked(useInteractionStore);

    mockStore.mockImplementation((selector) => {
      const state = {
        activeId: null,
        currentDeltaX: 0,
        operation: null,
      };
      return selector
        ? selector(state as ReturnType<typeof useInteractionStore.getState>)
        : state;
    });

    mockStore.subscribe = vi.fn(() => () => {});
  });

  afterEach(() => {
    waveformCacheService.clearAll();
    vi.restoreAllMocks();
    scrollListener = null;
  });

  it("shows the audio fallback while loading and hides it once waveform buckets are ready", async () => {
    const clip = {
      id: "audio-clip-1",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 5 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 5 * TICKS_PER_SECOND,
      croppedSourceDuration: 5 * TICKS_PER_SECOND,
      sourceDuration: 5 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    expect(screen.getByTestId("audio-waveform-fallback")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("audio-waveform-fallback")).toBeNull();
    });

    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(true);
    expect(mockAudioState.lastSamplesRequest).not.toBeNull();
  });

  it("caches silence and continues when a valid range decodes no samples", async () => {
    mockAudioState.buffers = [];
    audioAnalysis = createTestAudioAnalysisService();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clip = {
      id: "audio-clip-empty-range",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 5 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 5 * TICKS_PER_SECOND,
      croppedSourceDuration: 5 * TICKS_PER_SECOND,
      sourceDuration: 5 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("audio-waveform-fallback")).toBeNull();
    });
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  });

  it("treats a bucket beginning exactly at the source end as silence", async () => {
    const sourceEndSeconds = 32_768 / 48_000;
    const sourceEndTicks = sourceEndSeconds * TICKS_PER_SECOND;
    mockAudioState.durationSeconds = sourceEndSeconds;
    audioAnalysis = createTestAudioAnalysisService();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clip = {
      id: "audio-clip-terminal-bucket",
      assetId: "asset-1",
      start: 0,
      offset: sourceEndTicks,
      timelineDuration: TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: TICKS_PER_SECOND,
      croppedSourceDuration: TICKS_PER_SECOND,
      sourceDuration: sourceEndTicks,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("audio-waveform-fallback")).toBeNull();
    });
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  });

  it("renders waveform bars only inside the visible viewport window and repositions on scroll", async () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 1,
      durationSeconds: 3600,
      firstTimestampSeconds: 0,
      endTimestampSeconds: 3600,
      baseSamplesPerPeak: 128,
      peaksPerBucket: 256,
    });

    const bucket = new Int16Array(512);
    for (let peakIndex = 0; peakIndex < 256; peakIndex++) {
      const offset = peakIndex * 2;
      bucket[offset] = -16000;
      bucket[offset + 1] = 16000;
    }
    waveformCacheService.setBucket("asset-1", 0, 0, bucket);

    const clip = {
      id: "audio-clip-viewport",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 3600 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 3600 * TICKS_PER_SECOND,
      croppedSourceDuration: 3600 * TICKS_PER_SECOND,
      sourceDuration: 3600 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const initialBars = mockContext.fillRect.mock.calls.filter(
      (call: unknown[]) => call[2] === 1,
    );
    expect(initialBars.length).toBeGreaterThan(0);

    const initialMaxX = Math.max(
      ...initialBars.map((call: unknown[]) => Number(call[0])),
    );
    expect(initialMaxX).toBeLessThan(2200);

    mockScrollContainer.scrollLeft = 5000;

    await act(async () => {
      if (scrollListener) {
        scrollListener(new Event("scroll"));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const lastBarCall =
      mockContext.fillRect.mock.calls.filter((call: unknown[]) => call[2] === 1).at(-1) ??
      [];
    expect(Number(lastBarCall[0])).toBeLessThan(3100);

    const canvas = document.getElementById(`thumbnail-canvas-${clip.id}`);
    expect(canvas?.style.transform).toMatch(/translateX\(calc\(40\d+px/);
  });

  it("duplicates the same peak across adjacent columns at high zoom", async () => {
    waveformCacheService.acquire("asset-1");
    waveformCacheService.setMetadata("asset-1", {
      sampleRate: 48_000,
      numberOfChannels: 1,
      durationSeconds: 1,
      firstTimestampSeconds: 0,
      endTimestampSeconds: 1,
      baseSamplesPerPeak: 128,
      peaksPerBucket: 256,
    });

    const bucket = new Int16Array(512);
    bucket[0] = -20000;
    bucket[1] = 20000;
    bucket[2] = -5000;
    bucket[3] = 5000;
    waveformCacheService.setBucket("asset-1", 0, 0, bucket);

    vi.mocked(useTimelineViewStore).mockImplementation(
      (selector: (state: TimelineViewState) => unknown) => {
        const state = {
          scrollContainer: mockScrollContainer as unknown as HTMLElement,
          zoomScale: 20,
          setZoomScale: vi.fn(),
          ticksToPx: (ticks: number) => ticks,
          pxToTicks: (px: number) => px,
          setScrollContainer: vi.fn(),
        };
        return selector ? selector(state) : state;
      },
    );

    const clip = {
      id: "audio-clip-zoomed",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 1 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 1 * TICKS_PER_SECOND,
      croppedSourceDuration: 1 * TICKS_PER_SECOND,
      sourceDuration: 1 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const barHeights = mockContext.fillRect.mock.calls
      .filter((call: unknown[]) => call[2] === 1)
      .slice(0, 4)
      .map((call: unknown[]) => Number(call[3]));

    expect(barHeights.length).toBe(4);
    expect(new Set(barHeights).size).toBe(1);
  });

  it("keeps the fallback overlay when the audio track cannot be decoded", async () => {
    mockAudioState.canDecode = false;

    const clip = {
      id: "audio-clip-undecodable",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 5 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 5 * TICKS_PER_SECOND,
      croppedSourceDuration: 5 * TICKS_PER_SECOND,
      sourceDuration: 5 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [],
      name: "audio",
    };

    render(
      <ThumbnailCanvas
        audioAnalysis={audioAnalysis}
        clip={clip as unknown as import("../../../../types/TimelineTypes").AssetBackedBaseClip}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByTestId("audio-waveform-fallback")).toBeTruthy();
    expect(waveformCacheService.hasAnyBuckets("asset-1")).toBe(false);
  });
});
