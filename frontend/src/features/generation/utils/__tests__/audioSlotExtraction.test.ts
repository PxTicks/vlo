import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExtractAudioFromVideo, mockResolveAssetFileForGeneration } =
  vi.hoisted(() => ({
    mockExtractAudioFromVideo: vi.fn(),
    mockResolveAssetFileForGeneration: vi.fn(),
  }));

vi.mock("../manualSlotMedia", () => ({
  extractAudioFromVideo: mockExtractAudioFromVideo,
}));
vi.mock("../mediaInputAssets", () => ({
  resolveAssetFileForGeneration: mockResolveAssetFileForGeneration,
}));

import type { Asset } from "../../../../types/Asset";
import type { GenerationMediaInputValue } from "../../types";
import {
  NO_ASSET_AUDIO_TRACK_MESSAGE,
  collectStalledAudioExtractions,
  fillAudioSlotWithAsset,
  isAssetSlotExtractionCurrent,
} from "../audioSlotExtraction";

const videoAsset = {
  id: "asset-video",
  hash: "hash",
  name: "clip.mp4",
  type: "video",
  src: "assets/clip.mp4",
  hasAudio: true,
  createdAt: 0,
} as Asset;

const audioAsset = {
  id: "asset-audio",
  hash: "hash",
  name: "song.wav",
  type: "audio",
  src: "assets/song.wav",
  createdAt: 0,
} as Asset;

describe("fillAudioSlotWithAsset", () => {
  beforeEach(() => {
    mockExtractAudioFromVideo.mockReset();
    mockResolveAssetFileForGeneration.mockReset();
    mockResolveAssetFileForGeneration.mockResolvedValue(
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
    );
  });

  it("assigns an audio asset directly without extracting", () => {
    const setMediaInputAsset = vi.fn();

    const pending = fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: audioAsset,
      extractionRequestId: 1,
      setMediaInputAsset,
    });

    expect(pending).toBeNull();
    expect(mockExtractAudioFromVideo).not.toHaveBeenCalled();
    expect(setMediaInputAsset).toHaveBeenCalledWith("input-1", audioAsset);
  });

  it("marks the slot extracting, then stores the extracted audio track", async () => {
    const extracted = new File(["wav"], "audio.wav", { type: "audio/wav" });
    mockExtractAudioFromVideo.mockResolvedValue(extracted);
    const setMediaInputAsset = vi.fn();

    await fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: videoAsset,
      extractionRequestId: 3,
      setMediaInputAsset,
    });

    expect(setMediaInputAsset).toHaveBeenNthCalledWith(1, "input-1", videoAsset, {
      isExtracting: true,
      extractionRequestId: 3,
    });
    expect(setMediaInputAsset).toHaveBeenNthCalledWith(2, "input-1", videoAsset, {
      isExtracting: false,
      extractionRequestId: 3,
      extractedAudioFile: extracted,
      extractionError: null,
    });
  });

  it("reports a video that turns out to have no audio track", async () => {
    mockExtractAudioFromVideo.mockResolvedValue(null);
    const setMediaInputAsset = vi.fn();

    await fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: videoAsset,
      extractionRequestId: 1,
      setMediaInputAsset,
    });

    expect(setMediaInputAsset).toHaveBeenLastCalledWith("input-1", videoAsset, {
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: null,
      extractionError: NO_ASSET_AUDIO_TRACK_MESSAGE,
    });
  });

  it("surfaces extraction failures on the slot", async () => {
    mockExtractAudioFromVideo.mockRejectedValue(new Error("decode blew up"));
    const setMediaInputAsset = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: videoAsset,
      extractionRequestId: 1,
      setMediaInputAsset,
    });

    expect(setMediaInputAsset).toHaveBeenLastCalledWith("input-1", videoAsset, {
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: null,
      extractionError: "decode blew up",
    });
    consoleError.mockRestore();
  });

  it("does not overwrite the slot once a newer drop supersedes it", async () => {
    mockExtractAudioFromVideo.mockResolvedValue(
      new File(["wav"], "audio.wav", { type: "audio/wav" }),
    );
    const setMediaInputAsset = vi.fn();

    await fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: videoAsset,
      extractionRequestId: 1,
      setMediaInputAsset,
      isCurrentRequest: () => false,
    });

    // Only the optimistic "extracting" write lands.
    expect(setMediaInputAsset).toHaveBeenCalledTimes(1);
    expect(setMediaInputAsset).toHaveBeenCalledWith("input-1", videoAsset, {
      isExtracting: true,
      extractionRequestId: 1,
    });
  });
  it("extracts from a video whose ingest probe found no audio, so the slot can say why", async () => {
    // Only reachable via an external file drop, where hasAudio is unknown at
    // drag time.
    mockExtractAudioFromVideo.mockResolvedValue(null);
    const setMediaInputAsset = vi.fn();
    const silentAsset = { ...videoAsset, hasAudio: false } as Asset;

    await fillAudioSlotWithAsset({
      inputId: "input-1",
      asset: silentAsset,
      extractionRequestId: 1,
      setMediaInputAsset,
    });

    expect(mockExtractAudioFromVideo).toHaveBeenCalled();
    expect(setMediaInputAsset).toHaveBeenLastCalledWith("input-1", silentAsset, {
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: null,
      extractionError: NO_ASSET_AUDIO_TRACK_MESSAGE,
    });
  });
});

describe("isAssetSlotExtractionCurrent", () => {
  const extracting = {
    kind: "asset",
    asset: videoAsset,
    isExtracting: true,
    extractionRequestId: 4,
    extractedAudioFile: null,
    extractionError: null,
  } as GenerationMediaInputValue;

  it("holds while the slot still carries this exact request", () => {
    expect(isAssetSlotExtractionCurrent(extracting, "asset-video", 4)).toBe(true);
  });

  it("fails once the slot was cleared", () => {
    expect(isAssetSlotExtractionCurrent(null, "asset-video", 4)).toBe(false);
  });

  it("fails once another asset took the slot", () => {
    expect(isAssetSlotExtractionCurrent(extracting, "asset-other", 4)).toBe(
      false,
    );
  });

  it("fails once a newer request owns the slot", () => {
    expect(isAssetSlotExtractionCurrent(extracting, "asset-video", 3)).toBe(
      false,
    );
  });

  it("fails once the slot settled, so a late result cannot revive it", () => {
    expect(
      isAssetSlotExtractionCurrent(
        { ...extracting, isExtracting: false } as GenerationMediaInputValue,
        "asset-video",
        4,
      ),
    ).toBe(false);
  });

  it("fails for a value that is not an asset at all", () => {
    expect(
      isAssetSlotExtractionCurrent(
        { kind: "frame" } as GenerationMediaInputValue,
        "asset-video",
        4,
      ),
    ).toBe(false);
  });
});
describe("collectStalledAudioExtractions", () => {
  const extracting = {
    kind: "asset",
    asset: videoAsset,
    isExtracting: true,
    extractionRequestId: 2,
  } as GenerationMediaInputValue;
  const settled = {
    kind: "asset",
    asset: videoAsset,
    isExtracting: false,
    extractedAudioFile: new File(["wav"], "audio.wav", { type: "audio/wav" }),
  } as GenerationMediaInputValue;

  it("reports a pending value at the slot a reorder moved it to", () => {
    // Slot 1 held the extracting value; a swap parked it in slot 2.
    const slots: Record<string, GenerationMediaInputValue | null> = {
      "20:audio": settled,
      "20:audio#1": extracting,
    };

    expect(
      collectStalledAudioExtractions(
        ["20:audio", "20:audio#1"],
        (inputId) => slots[inputId] ?? null,
      ),
    ).toEqual([{ inputId: "20:audio#1", asset: videoAsset }]);
  });

  it("reports nothing when no slot is mid-extraction", () => {
    expect(
      collectStalledAudioExtractions(["20:audio"], () => settled),
    ).toEqual([]);
  });

  it("ignores emptied slots and non-asset values", () => {
    expect(
      collectStalledAudioExtractions(["a", "b"], (inputId) =>
        inputId === "a"
          ? null
          : ({ kind: "timelineSelection", isExtracting: true } as GenerationMediaInputValue),
      ),
    ).toEqual([]);
  });

  it("visits each slot once even when an id repeats", () => {
    expect(
      collectStalledAudioExtractions(
        ["20:audio", "20:audio"],
        () => extracting,
      ),
    ).toEqual([{ inputId: "20:audio", asset: videoAsset }]);
  });
});
