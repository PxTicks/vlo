import type { BufferTarget, Input, InputAudioTrack } from "mediabunny";
import { fake } from "../../../../testUtils/libraryFakes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineSelection } from "../../../../types/TimelineTypes";

const mocks = vi.hoisted(() => ({
  audioTrack: { id: 1 } satisfies Partial<InputAudioTrack> as unknown as
    | InputAudioTrack
    | null,
  target: {
    buffer: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer | null,
  } satisfies Partial<BufferTarget>,
  input: {
    getPrimaryAudioTrack: vi.fn<Input["getPrimaryAudioTrack"]>(),
    computeDuration: vi.fn<Input["computeDuration"]>(async () => 0),
    dispose: vi.fn<Input["dispose"]>(),
  } satisfies Partial<Input>,
  conversion: {
    isValid: true as boolean,
    execute: vi.fn<import("mediabunny").Conversion["execute"]>(async () => undefined),
  } satisfies Partial<import("mediabunny").Conversion>,
  renderTimelineSelectionToMp4: vi.fn(),
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: ["all"],
  BlobSource: vi.fn(function (file: File) {
    return { file };
  }),
  BufferTarget: vi.fn(function () {
    return mocks.target;
  }),
  Input: vi.fn(function () {
    mocks.input.getPrimaryAudioTrack.mockImplementation(
      async () => mocks.audioTrack,
    );
    return mocks.input;
  }),
  Output: vi.fn(function (options: unknown) {
    return options;
  }),
  WavOutputFormat: vi.fn(function () {
    return { kind: "wav" };
  }),
  Conversion: {
    init: vi.fn(async () => mocks.conversion),
  },
}));

vi.mock("../inputSelection", () => ({
  renderTimelineSelectionToMp4: mocks.renderTimelineSelectionToMp4,
}));

import { Conversion } from "mediabunny";
import {
  createAudioSelectionPlaceholderFile,
  extractAudioFromSelection,
  extractAudioFromVideo,
  probeAudioDurationTicks,
  trimAudioFile,
} from "../manualSlotMedia";

describe("manualSlotMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversion.isValid = true;
    mocks.audioTrack = fake<InputAudioTrack>({ id: 1 });
    mocks.target.buffer = new Uint8Array([1, 2, 3]).buffer;
    mocks.renderTimelineSelectionToMp4.mockResolvedValue(
      new File(["video"], "selection.mp4", { type: "video/mp4" }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a stable text placeholder for audio selections", () => {
    const file = createAudioSelectionPlaceholderFile();
    expect(file).toMatchObject({
      name: "generation-audio-selection-placeholder.txt",
      type: "text/plain",
    });
  });

  it("extracts a WAV audio track and disposes the input", async () => {
    const source = new File(["video"], "source.mp4");
    const result = await extractAudioFromVideo(source);

    expect(Conversion.init).toHaveBeenCalledWith(
      expect.objectContaining({
        input: mocks.input,
        video: { discard: true },
      }),
    );
    expect(mocks.conversion.execute).toHaveBeenCalled();
    expect(result).toBeInstanceOf(File);
    expect(result).toMatchObject({ type: "audio/wav" });
    expect(result?.name).toMatch(/^generation-audio-\d+\.wav$/);
    expect(mocks.input.dispose).toHaveBeenCalled();
  });

  it("returns null for absent tracks or missing conversion output", async () => {
    mocks.audioTrack = null;
    await expect(
      extractAudioFromVideo(new File(["video"], "silent.mp4")),
    ).resolves.toBeNull();

    mocks.audioTrack = fake<InputAudioTrack>({ id: 1 });
    mocks.target.buffer = null;
    await expect(
      extractAudioFromVideo(new File(["video"], "broken.mp4")),
    ).resolves.toBeNull();
    expect(mocks.input.dispose).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation before and during extraction", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      extractAudioFromVideo(new File(["video"], "source.mp4"), {
        signal: preAborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    mocks.conversion.execute.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      extractAudioFromVideo(new File(["video"], "source.mp4"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.input.dispose).toHaveBeenCalled();
  });

  it("trims audio to the crop window and delivers it as WAV", async () => {
    // 96000 ticks to the second: seconds one through two of the source.
    const result = await trimAudioFile(
      new File(["audio"], "score.wav"),
      96_000,
      192_000,
    );

    expect(Conversion.init).toHaveBeenCalledWith(
      expect.objectContaining({
        input: mocks.input,
        trim: { start: 1, end: 2 },
        video: { discard: true },
      }),
    );
    expect(mocks.conversion.execute).toHaveBeenCalled();
    expect(result).toMatchObject({ type: "audio/wav" });
    expect(mocks.input.dispose).toHaveBeenCalled();
  });

  it("refuses to trim an empty range, a silent source, or an unusable conversion", async () => {
    const file = new File(["audio"], "score.wav");

    await expect(trimAudioFile(file, 96_000, 96_000)).resolves.toBeNull();
    expect(Conversion.init).not.toHaveBeenCalled();

    mocks.audioTrack = null;
    await expect(trimAudioFile(file, 0, 96_000)).resolves.toBeNull();

    mocks.audioTrack = fake<InputAudioTrack>({ id: 1 });
    mocks.conversion.isValid = false;
    await expect(trimAudioFile(file, 0, 96_000)).resolves.toBeNull();
    expect(mocks.conversion.execute).not.toHaveBeenCalled();

    mocks.conversion.isValid = true;
    mocks.target.buffer = null;
    await expect(trimAudioFile(file, 0, 96_000)).resolves.toBeNull();
  });

  it("reads a duration in ticks, treating an unreadable one as zero", async () => {
    mocks.input.computeDuration.mockResolvedValueOnce(2);
    await expect(
      probeAudioDurationTicks(new File(["audio"], "score.wav")),
    ).resolves.toBe(192_000);

    mocks.input.computeDuration.mockResolvedValueOnce(Number.NaN);
    await expect(
      probeAudioDurationTicks(new File(["audio"], "score.wav")),
    ).resolves.toBe(0);
    expect(mocks.input.dispose).toHaveBeenCalledTimes(2);
  });

  it("renders a selection, injects a valid fallback FPS, and extracts audio", async () => {
    const selection = {
      clips: [],
      start: 0,
      duration: 100,
    } as unknown as TimelineSelection;

    await extractAudioFromSelection(selection, { exportFps: 29.6 });

    expect(mocks.renderTimelineSelectionToMp4).toHaveBeenCalledWith(
      expect.objectContaining({ fps: 30 }),
      { signal: undefined },
    );
    expect(selection.fps).toBeUndefined();
  });

  it("preserves a valid selection FPS and ignores invalid fallbacks", async () => {
    const withFps = {
      clips: [],
      start: 0,
      duration: 100,
      fps: 24,
    } as unknown as TimelineSelection;
    await extractAudioFromSelection(withFps, { exportFps: 60 });
    expect(mocks.renderTimelineSelectionToMp4).toHaveBeenLastCalledWith(
      expect.objectContaining({ fps: 24 }),
      expect.anything(),
    );

    const withoutFps = {
      clips: [],
      start: 0,
      duration: 100,
    } as unknown as TimelineSelection;
    await extractAudioFromSelection(withoutFps, {
      exportFps: Number.NaN,
    });
    expect(mocks.renderTimelineSelectionToMp4).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ fps: expect.anything() }),
      expect.anything(),
    );
  });
});
