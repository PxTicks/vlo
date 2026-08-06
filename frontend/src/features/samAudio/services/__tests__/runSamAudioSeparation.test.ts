import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { AudioAnalysisService, useAssetStore } from "../../../userAssets";
import type { Input, InputAudioTrack } from "mediabunny";
import { runSamAudioSeparation } from "../runSamAudioSeparation";

const operationMocks = vi.hoisted(() => ({
  mockEnsureAssetFileLoaded: vi.fn(),
  mockFetchStem: vi.fn(),
  mockWaitForSeparationJob: vi.fn(),
  mockRegisterSourceAudio: vi.fn(),
  mockSubmitSeparationJob: vi.fn(),
}));

vi.mock("../samAudioApi", () => ({
  fetchStem: operationMocks.mockFetchStem,
  registerSourceAudio: operationMocks.mockRegisterSourceAudio,
  submitSeparationJob: operationMocks.mockSubmitSeparationJob,
  waitForSeparationJob: operationMocks.mockWaitForSeparationJob,
}));

vi.mock("../../../userAssets/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../userAssets/api")>();
  return {
    ...actual,
    ensureAssetFileLoaded: operationMocks.mockEnsureAssetFileLoaded,
  };
});

const sourceTrack: TimelineTrack = {
  id: "track-source",
  type: "visual",
  label: "Video",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const sourceClip: TimelineClip = {
  id: "clip-source",
  trackId: sourceTrack.id,
  start: TICKS_PER_SECOND * 10,
  timelineDuration: TICKS_PER_SECOND * 5,
  type: "video",
  name: "Source Clip",
  assetId: "asset-source",
  transformations: [],
  offset: TICKS_PER_SECOND * 2,
  sourceDuration: TICKS_PER_SECOND * 20,
  transformedDuration: TICKS_PER_SECOND * 5,
  transformedOffset: 0,
  croppedSourceDuration: TICKS_PER_SECOND * 5,
};

const selectedElsewhereClip: TimelineClip = {
  ...sourceClip,
  id: "clip-selected-elsewhere",
  assetId: "asset-selected-elsewhere",
};

const sourceAsset: Asset = {
  id: "asset-source",
  hash: "hash-source",
  name: "source.mp4",
  type: "video",
  src: "blob:source",
  duration: 20,
  hasAudio: true,
  createdAt: 1,
};

function makeStemAsset(stem: "target" | "residual"): Asset {
  return {
    id: `asset-${stem}`,
    hash: `hash-${stem}`,
    name: `${stem}.wav`,
    type: "audio",
    src: `blob:${stem}`,
    duration: 5,
    createdAt: 2,
  };
}

describe("runSamAudioSeparation", () => {
  let analysisEndSeconds = 20;
  let audioAnalysis: AudioAnalysisService;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    analysisEndSeconds = 20;
    const track = {
      sampleRate: 48_000,
      numberOfChannels: 2,
      canDecode: vi.fn(async () => true),
      computeDuration: vi.fn(async () => analysisEndSeconds),
      getFirstTimestamp: vi.fn(async () => 0),
    } as unknown as InputAudioTrack;
    const input = {
      getPrimaryAudioTrack: vi.fn(async () => track),
    } as unknown as Input;
    audioAnalysis = new AudioAnalysisService({
      getInput: async () => input,
    });
    useTimelineStore.getState().replaceTimelineSnapshot({
      clips: [sourceClip, selectedElsewhereClip],
      tracks: [sourceTrack],
    });
    useTimelineStore.setState({
      selectedClipIds: [selectedElsewhereClip.id],
    });
    operationMocks.mockEnsureAssetFileLoaded.mockResolvedValue(
      new File(["source"], "source.mp4", { type: "video/mp4" }),
    );
    operationMocks.mockRegisterSourceAudio.mockResolvedValue({
      sourceId: "sam-source",
      sampleRate: 48_000,
      channels: 2,
      durationSec: 20,
      durationTicks: TICKS_PER_SECOND * 20,
    });
    operationMocks.mockSubmitSeparationJob.mockResolvedValue({ jobId: "job-1" });
    operationMocks.mockWaitForSeparationJob.mockResolvedValue({
      jobId: "job-1",
      status: "done",
      progress: 1,
      message: "done",
      error: null,
      sourceId: "sam-source",
      startTicks: sourceClip.offset,
      durationTicks: sourceClip.croppedSourceDuration,
      resultDurationTicks: sourceClip.croppedSourceDuration,
    });
    operationMocks.mockFetchStem.mockResolvedValue({
      blob: new Blob(["stem"], { type: "audio/wav" }),
      sampleRate: 48_000,
      durationTicks: sourceClip.croppedSourceDuration,
      predictedSpans: null,
    });
    const addLocalAsset = vi
      .fn()
      .mockResolvedValueOnce(makeStemAsset("target"))
      .mockResolvedValueOnce(makeStemAsset("residual"));
    useAssetStore.setState({
      assets: [sourceAsset],
      addLocalAsset,
    });
  });

  it("uses the explicit clipId instead of the selected timeline clip", async () => {
    vi.useFakeTimers();
    const resultPromise = runSamAudioSeparation(
      {
        clipId: sourceClip.id,
        textPrompt: "vocals",
      },
      { analysis: audioAnalysis },
    );

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.jobId).toBe("job-1");
    expect(operationMocks.mockSubmitSeparationJob).toHaveBeenCalledWith(
      {
        sourceId: "sam-source",
        startTicks: sourceClip.offset,
        durationTicks: sourceClip.croppedSourceDuration,
        prompt: {
          text: "vocals",
          rerankingCandidates: 1,
        },
      },
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("clamps the submitted window to the locally inspected source extent", async () => {
    vi.useFakeTimers();
    analysisEndSeconds = 6;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resultPromise = runSamAudioSeparation(
      {
        clipId: sourceClip.id,
        textPrompt: "vocals",
      },
      { analysis: audioAnalysis },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;

    expect(operationMocks.mockSubmitSeparationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        startTicks: TICKS_PER_SECOND * 2,
        durationTicks: TICKS_PER_SECOND * 4,
      }),
      expect.anything(),
    );
    expect(warning).toHaveBeenCalledWith(
      "SAM-Audio source window shortened after local inspection",
      expect.objectContaining({
        requestedDurationTicks: TICKS_PER_SECOND * 5,
        availableDurationTicks: TICKS_PER_SECOND * 4,
      }),
    );
    warning.mockRestore();
  });

  it("leaves a sub-frame decoder disagreement to the backend", async () => {
    vi.useFakeTimers();
    analysisEndSeconds = 7 - 1 / 120;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resultPromise = runSamAudioSeparation(
      {
        clipId: sourceClip.id,
        textPrompt: "vocals",
      },
      { analysis: audioAnalysis },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;

    expect(operationMocks.mockSubmitSeparationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        durationTicks: TICKS_PER_SECOND * 5,
      }),
      expect.anything(),
    );
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("rejects span prompts that do not overlap the target clip before submitting a job", async () => {
    await expect(
      runSamAudioSeparation(
        {
          clipId: sourceClip.id,
          spanSelection: {
            startTick: TICKS_PER_SECOND,
            endTick: TICKS_PER_SECOND * 2,
          },
        },
        { analysis: audioAnalysis },
      ),
    ).rejects.toThrow("overlaps the selected clip");

    expect(operationMocks.mockSubmitSeparationJob).not.toHaveBeenCalled();
  });

  it("inserts target and residual stems on new audio tracks below the source track", async () => {
    vi.useFakeTimers();
    const resultPromise = runSamAudioSeparation(
      {
        clipId: sourceClip.id,
        textPrompt: "piano",
      },
      { analysis: audioAnalysis },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;

    const timeline = useTimelineStore.getState();
    const sourceTrackIndex = timeline.tracks.findIndex(
      (candidate) => candidate.id === sourceTrack.id,
    );
    const targetClip = timeline.clips.find(
      (candidate) => "assetId" in candidate && candidate.assetId === "asset-target",
    );
    const residualClip = timeline.clips.find(
      (candidate) =>
        "assetId" in candidate && candidate.assetId === "asset-residual",
    );

    expect(sourceTrackIndex).toBeGreaterThanOrEqual(0);
    expect(targetClip).toEqual(
      expect.objectContaining({
        type: "audio",
        name: "Source Clip Target",
        start: sourceClip.start,
        offset: 0,
        croppedSourceDuration: sourceClip.croppedSourceDuration,
      }),
    );
    expect(residualClip).toEqual(
      expect.objectContaining({
        type: "audio",
        name: "Source Clip Residual",
        start: sourceClip.start,
        offset: 0,
        croppedSourceDuration: sourceClip.croppedSourceDuration,
      }),
    );
    expect(timeline.tracks[sourceTrackIndex + 1]?.id).toBe(
      targetClip?.trackId,
    );
    expect(timeline.tracks[sourceTrackIndex + 2]?.id).toBe(
      residualClip?.trackId,
    );
    expect(timeline.tracks[sourceTrackIndex + 1]?.type).toBe("audio");
    expect(timeline.tracks[sourceTrackIndex + 2]?.type).toBe("audio");
    expect(timeline.clips.find((candidate) => candidate.id === sourceClip.id))
      .toEqual(expect.objectContaining({ isMuted: true }));
  });
});
