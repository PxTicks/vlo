import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAssetById, mockGetTimelineClips, mockExtractAudioFromVideo } =
  vi.hoisted(() => ({
    mockGetAssetById: vi.fn(),
    mockGetTimelineClips: vi.fn(() => []),
    mockExtractAudioFromVideo: vi.fn(),
  }));

vi.mock("../../../userAssets/api", () => ({ getAssetById: mockGetAssetById }));
vi.mock("../../../timeline/api", () => ({
  getTimelineClips: mockGetTimelineClips,
}));
vi.mock("../../utils/manualSlotMedia", () => ({
  extractAudioFromVideo: mockExtractAudioFromVideo,
  extractAudioFromSelection: vi.fn(),
  createAudioSelectionPlaceholderFile: vi.fn(),
}));
vi.mock("../../utils/mediaInputAssets", () => ({
  resolveAssetFileForGeneration: vi.fn(async () =>
    new File(["video"], "clip.mp4", { type: "video/mp4" }),
  ),
}));

import type { GeneratedCreationMetadata } from "../../../../types/Asset";
import type { GenerationMediaInputValue, WorkflowInput } from "../../types";
import { restoreMediaInputsFromMetadata } from "../metadata";

const audioInput = {
  id: "20:audio",
  nodeId: "20",
  classType: "LoadAudio",
  inputType: "audio",
  param: "audio",
  label: "Audio",
  currentValue: null,
  origin: "rule",
} as unknown as WorkflowInput;

const videoAsset = {
  id: "asset-video",
  hash: "hash",
  name: "clip.mp4",
  type: "video",
  src: "assets/clip.mp4",
  hasAudio: true,
  createdAt: 0,
};

const metadata = {
  source: "generated",
  workflowName: "wf",
  inputs: [
    {
      nodeId: "20",
      inputId: "20:audio",
      kind: "draggedAsset",
      parentAssetId: "asset-video",
    },
  ],
} as unknown as GeneratedCreationMetadata;

describe("restoring a video asset into an audio slot from replay metadata", () => {
  beforeEach(() => {
    mockGetAssetById.mockReset();
    mockGetAssetById.mockReturnValue(videoAsset);
    mockExtractAudioFromVideo.mockReset();
  });

  it("seeds the slot as extracting and writes the audio track back", async () => {
    const extracted = new File(["wav"], "audio.wav", { type: "audio/wav" });
    let resolveExtraction: (file: File | null) => void = () => {};
    mockExtractAudioFromVideo.mockReturnValue(
      new Promise<File | null>((resolve) => {
        resolveExtraction = resolve;
      }),
    );

    const mediaInputs: Record<string, GenerationMediaInputValue | null> = {};
    const setMediaInputAsset = vi.fn((inputId, asset, options) => {
      mediaInputs[inputId] = {
        kind: "asset",
        asset,
        ...options,
      } as GenerationMediaInputValue;
    });

    await restoreMediaInputsFromMetadata(
      metadata,
      [audioInput],
      [],
      {
        setMediaInputAsset,
        setMediaInputFrameWithSelection: vi.fn(),
        setMediaInputTimelineSelection: vi.fn(),
      } as never,
      { getMediaInputs: () => mediaInputs },
    );

    expect(mediaInputs["20:audio"]).toMatchObject({ isExtracting: true });

    resolveExtraction(extracted);
    await vi.waitFor(() =>
      expect(mediaInputs["20:audio"]).toMatchObject({
        isExtracting: false,
        extractedAudioFile: extracted,
      }),
    );
  });

  it("does not resurrect a slot the user cleared while restoration was extracting", async () => {
    let resolveExtraction: (file: File | null) => void = () => {};
    mockExtractAudioFromVideo.mockReturnValue(
      new Promise<File | null>((resolve) => {
        resolveExtraction = resolve;
      }),
    );

    const mediaInputs: Record<string, GenerationMediaInputValue | null> = {};
    const setMediaInputAsset = vi.fn((inputId, asset, options) => {
      mediaInputs[inputId] = {
        kind: "asset",
        asset,
        ...options,
      } as GenerationMediaInputValue;
    });

    await restoreMediaInputsFromMetadata(
      metadata,
      [audioInput],
      [],
      {
        setMediaInputAsset,
        setMediaInputFrameWithSelection: vi.fn(),
        setMediaInputTimelineSelection: vi.fn(),
      } as never,
      { getMediaInputs: () => mediaInputs },
    );

    // Restoration hands control back immediately, so the user can act now.
    delete mediaInputs["20:audio"];
    setMediaInputAsset.mockClear();

    resolveExtraction(new File(["wav"], "audio.wav", { type: "audio/wav" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(setMediaInputAsset).not.toHaveBeenCalled();
    expect(mediaInputs["20:audio"]).toBeUndefined();
  });

  it("does not overwrite a different asset the user dropped meanwhile", async () => {
    let resolveExtraction: (file: File | null) => void = () => {};
    mockExtractAudioFromVideo.mockReturnValue(
      new Promise<File | null>((resolve) => {
        resolveExtraction = resolve;
      }),
    );

    const mediaInputs: Record<string, GenerationMediaInputValue | null> = {};
    const setMediaInputAsset = vi.fn((inputId, asset, options) => {
      mediaInputs[inputId] = {
        kind: "asset",
        asset,
        ...options,
      } as GenerationMediaInputValue;
    });

    await restoreMediaInputsFromMetadata(
      metadata,
      [audioInput],
      [],
      {
        setMediaInputAsset,
        setMediaInputFrameWithSelection: vi.fn(),
        setMediaInputTimelineSelection: vi.fn(),
      } as never,
      { getMediaInputs: () => mediaInputs },
    );

    const userChoice = {
      kind: "asset",
      asset: { ...videoAsset, id: "asset-user-pick" },
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: new File(["wav"], "user.wav", { type: "audio/wav" }),
      extractionError: null,
    } as unknown as GenerationMediaInputValue;
    mediaInputs["20:audio"] = userChoice;
    setMediaInputAsset.mockClear();

    resolveExtraction(new File(["wav"], "audio.wav", { type: "audio/wav" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(setMediaInputAsset).not.toHaveBeenCalled();
    expect(mediaInputs["20:audio"]).toBe(userChoice);
  });
});
