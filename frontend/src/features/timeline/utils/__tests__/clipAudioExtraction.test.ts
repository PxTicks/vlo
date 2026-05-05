import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExtractedAudioClipMetadata,
  createTimelineSelectionForClipAudioExtraction,
  extractTimelineClipAudioAsset,
} from "../clipAudioExtraction";

const extractionState = vi.hoisted(() => ({
  ensureAssetSourceLoaded: vi.fn(),
  addLocalAsset: vi.fn(),
  extractPrimaryAudioTrack: vi.fn(),
}));

vi.mock("../../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: () => ({
      config: {
        fps: 24,
      },
    }),
  },
}));

vi.mock("../../../userAssets/publicApi", () => ({
  ensureAssetSourceLoaded: extractionState.ensureAssetSourceLoaded,
}));

vi.mock("../../../userAssets/useAssetStore", () => ({
  useAssetStore: {
    getState: () => ({
      addLocalAsset: extractionState.addLocalAsset,
    }),
  },
}));

vi.mock("../../../userAssets/services/MediaProcessingService", () => ({
  mediaProcessingService: {
    extractPrimaryAudioTrack: extractionState.extractPrimaryAudioTrack,
  },
}));

describe("clipAudioExtraction", () => {
  beforeEach(() => {
    extractionState.ensureAssetSourceLoaded.mockReset();
    extractionState.addLocalAsset.mockReset();
    extractionState.extractPrimaryAudioTrack.mockReset();
    extractionState.addLocalAsset.mockResolvedValue({
      id: "new-asset",
      name: "new-asset.wav",
    });
  });

  it("builds clip metadata with only audio-compatible transforms", () => {
    const clip = {
      id: "clip-1",
      trackId: "track-1",
      start: 120,
      timelineDuration: 240,
      type: "video" as const,
      name: "Source Clip.mp4",
      assetId: "asset-1",
      transformations: [
        {
          id: "fit-1",
          type: "fitMode",
          isEnabled: true,
          parameters: { fitMode: "cover" },
        },
        {
          id: "position-1",
          type: "position",
          isEnabled: true,
          parameters: { x: 25, y: 10 },
        },
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "volume-1",
          type: "volume",
          isEnabled: true,
          parameters: {
            gain: {
              type: "spline",
              points: [
                { time: 0, value: 1 },
                { time: 120, value: 0.5 },
              ],
            },
          },
        },
      ],
      offset: 30,
      sourceDuration: 480,
      transformedDuration: 480,
      transformedOffset: 45,
      croppedSourceDuration: 300,
      isMuted: true,
    };

    expect(buildExtractedAudioClipMetadata(clip)).toEqual({
      sourceAssetId: "asset-1",
      sourceClipType: "video",
      timelineDuration: 240,
      croppedSourceDuration: 300,
      offset: 30,
      transformedOffset: 45,
      transformations: [
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
        {
          id: "volume-1",
          type: "volume",
          isEnabled: true,
          parameters: {
            gain: {
              type: "spline",
              points: [
                { time: 0, value: 1 },
                { time: 120, value: 0.5 },
              ],
            },
          },
        },
      ],
    });
  });

  it("builds a single-clip selection that preserves the original clip state", () => {
    const clip = {
      id: "clip-1",
      trackId: "track-1",
      start: 120,
      timelineDuration: 240,
      type: "video" as const,
      name: "Source Clip.mp4",
      assetId: "asset-1",
      transformations: [
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
      offset: 30,
      sourceDuration: 480,
      transformedDuration: 480,
      transformedOffset: 45,
      croppedSourceDuration: 300,
      isMuted: true,
    };
    const track = {
      id: "track-1",
      label: "Track 1",
      type: "visual" as const,
      isVisible: false,
      isMuted: true,
      isLocked: false,
    };

    const selection = createTimelineSelectionForClipAudioExtraction(
      clip,
      track,
      29.6,
    );

    expect(selection).toEqual({
      start: 120,
      end: 360,
      clips: [clip],
      tracks: [track],
      includedTrackIds: ["track-1"],
      fps: 30,
    });
    expect(selection.clips[0]).not.toBe(clip);
    expect(selection.tracks?.[0]).not.toBe(track);
  });

  it("duplicates audio source assets directly when extracting an audio clip", async () => {
    const sourceFile = new File(["audio-bytes"], "voice.wav", {
      type: "audio/wav",
    });
    extractionState.ensureAssetSourceLoaded.mockResolvedValue({
      id: "asset-1",
      name: "voice.wav",
      type: "audio",
      file: sourceFile,
    });

    await extractTimelineClipAudioAsset(
      {
        id: "clip-audio",
        trackId: "track-1",
        start: 0,
        timelineDuration: 120,
        type: "audio",
        name: "Voice Clip",
        assetId: "asset-1",
        transformations: [],
        offset: 12,
        sourceDuration: 480,
        transformedDuration: 480,
        transformedOffset: 0,
        croppedSourceDuration: 120,
      },
      {
        id: "track-1",
        label: "Track 1",
        type: "audio",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    );

    expect(extractionState.extractPrimaryAudioTrack).not.toHaveBeenCalled();
    const [duplicatedFile, creationMetadata, familyId, options] =
      extractionState.addLocalAsset.mock.calls[0] ?? [];
    expect(duplicatedFile).toBeInstanceOf(File);
    expect(duplicatedFile).not.toBe(sourceFile);
    expect(duplicatedFile.name).toBe("voice.wav");
    expect(duplicatedFile.size).toBe(sourceFile.size);
    expect(duplicatedFile.type).toBe("audio/wav");
    expect(creationMetadata).toEqual(
      expect.objectContaining({
        source: "extracted",
        extractedAudioClip: expect.objectContaining({
          sourceAssetId: "asset-1",
          sourceClipType: "audio",
          timelineDuration: 120,
          offset: 12,
        }),
      }),
    );
    expect(familyId).toBeUndefined();
    expect(options).toEqual({ allowDuplicateHash: true });
  });

  it("demuxes video source assets when extracting a video clip", async () => {
    const sourceFile = new File(["video-bytes"], "clip.mp4", {
      type: "video/mp4",
    });
    const extractedAudio = new File(["audio-bytes"], "clip-audio.m4a", {
      type: "audio/mp4",
    });
    extractionState.ensureAssetSourceLoaded.mockResolvedValue({
      id: "asset-1",
      name: "clip.mp4",
      type: "video",
      hasAudio: true,
      file: sourceFile,
    });
    extractionState.extractPrimaryAudioTrack.mockResolvedValue(extractedAudio);

    await extractTimelineClipAudioAsset(
      {
        id: "clip-video",
        trackId: "track-1",
        start: 24,
        timelineDuration: 240,
        type: "video",
        name: "Video Clip",
        assetId: "asset-1",
        transformations: [],
        offset: 0,
        sourceDuration: 960,
        transformedDuration: 960,
        transformedOffset: 0,
        croppedSourceDuration: 240,
      },
      {
        id: "track-1",
        label: "Track 1",
        type: "visual",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    );

    expect(extractionState.extractPrimaryAudioTrack).toHaveBeenCalledWith(
      sourceFile,
    );
    expect(extractionState.addLocalAsset).toHaveBeenCalledWith(
      extractedAudio,
      expect.objectContaining({
        source: "extracted",
        extractedAudioClip: expect.objectContaining({
          sourceAssetId: "asset-1",
          sourceClipType: "video",
          timelineDuration: 240,
        }),
      }),
      undefined,
      { allowDuplicateHash: true },
    );
  });
});
