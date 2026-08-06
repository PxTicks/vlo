import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render } from "@testing-library/react";
import { ThumbnailCanvas } from "../ThumbnailCanvas";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import type { TimelineViewState } from "../../hooks/useTimelineViewStore";
import { AudioAnalysisService, useAsset } from "../../../userAssets";
import type { Input, InputAudioTrack } from "mediabunny";
import { TICKS_PER_SECOND } from "../../constants";
import * as TimeCalculation from "../../../transformations";
import { waveformCacheService } from "../../services/WaveformCacheService";

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

vi.mock("../../../transformations", () => ({
  calculateClipTime: vi.fn((_clip, time) => time * 2),
}));

describe("WaveformCanvas Speed Ramp", () => {
  let audioAnalysis: AudioAnalysisService;

  beforeEach(async () => {
    vi.clearAllMocks();
    waveformCacheService.clearAll();
    const track = {
      sampleRate: 48_000,
      numberOfChannels: 1,
      canDecode: vi.fn(async () => true),
      computeDuration: vi.fn(async () => 10),
      getFirstTimestamp: vi.fn(async () => 0),
    } as unknown as InputAudioTrack;
    const input = {
      getPrimaryAudioTrack: vi.fn(async () => track),
    } as unknown as Input;
    audioAnalysis = new AudioAnalysisService({
      getInput: async () => input,
      createSink: () => ({
        buffers: async function* () {
          yield {
            timestamp: 0,
            duration: 1024 / 48_000,
            buffer: {
              sampleRate: 48_000,
              numberOfChannels: 1,
              length: 1024,
              getChannelData: () => new Float32Array(1024).fill(0.5),
            } as unknown as AudioBuffer,
          };
        },
      }),
    });

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);

    vi.mocked(useTimelineViewStore).mockImplementation(
      (selector: (state: TimelineViewState) => unknown) => {
        const state = {
          scrollContainer: {
            scrollLeft: 0,
            clientWidth: 1000,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          } as unknown as HTMLElement,
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
  });

  it("calls calculateClipTime while collecting and drawing waveform data", async () => {
    const clip = {
      id: "clip-ramp",
      assetId: "asset-1",
      start: 0,
      offset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
      sourceDuration: 10 * TICKS_PER_SECOND,
      type: "audio",
      transformations: [
        { id: "t1", type: "speed", isEnabled: true, parameters: { factor: 2 } },
      ],
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

    expect(TimeCalculation.calculateClipTime).toHaveBeenCalled();
    expect(TimeCalculation.calculateClipTime).toHaveBeenCalledWith(
      expect.objectContaining({ id: "clip-ramp" }),
      expect.any(Number),
    );
  });
});
