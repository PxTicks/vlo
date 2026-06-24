import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const context2d = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
  const canvas = {
    getContext: vi.fn(() => context2d),
  };
  const videoSource = {
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const audioSource = {
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const output = {
    addVideoTrack: vi.fn(async () => undefined),
    addAudioTrack: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  };
  const target = { buffer: new Uint8Array([1, 2, 3]) as Uint8Array | null };
  return {
    context2d,
    canvas,
    videoSource,
    audioSource,
    output,
    target,
    compatibility: vi.fn((value: unknown) => ({ value })),
  };
});

vi.mock("mediabunny", () => ({
  Output: vi.fn(function () {
    return mocks.output;
  }),
  Mp4OutputFormat: vi.fn(function () {
    return { kind: "mp4" };
  }),
  BufferTarget: vi.fn(function () {
    return mocks.target;
  }),
  CanvasSource: vi.fn(function () {
    return mocks.videoSource;
  }),
  AudioBufferSource: vi.fn(function () {
    return mocks.audioSource;
  }),
}));

vi.mock("../../../../../shared/utils/assetFamilies", () => ({
  buildAssetFamilyCompatibility: mocks.compatibility,
}));

vi.mock("../media", () => ({
  createOutputCanvas: vi.fn(() => mocks.canvas),
  isCanvas2DContext: vi.fn((value) => value === mocks.context2d),
}));

import {
  AudioBufferSource,
  CanvasSource,
  Output,
} from "mediabunny";
import {
  decodeAudioBuffer,
  packageFramesAndAudioToVideo,
} from "../videoPackaging";

function audioFile(name = "audio.wav"): File {
  const file = new File(["audio"], name);
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: vi.fn(async () => new ArrayBuffer(8)),
  });
  return file;
}

describe("videoPackaging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.target.buffer = new Uint8Array([1, 2, 3]);
    mocks.canvas.getContext.mockReturnValue(mocks.context2d);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 640,
        height: 360,
        close: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "webkitAudioContext");
  });

  it("decodes audio using a 48kHz context and closes it", async () => {
    const decoded = { duration: 2.5 } as AudioBuffer;
    const context = {
      decodeAudioData: vi.fn(async () => decoded),
      close: vi.fn(async () => undefined),
    };
    const AudioContextMock = vi.fn(function () {
      return context;
    });
    vi.stubGlobal("AudioContext", AudioContextMock);
    const file = audioFile();

    await expect(decodeAudioBuffer(file)).resolves.toBe(decoded);
    expect(AudioContextMock).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(context.decodeAudioData).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(context.close).toHaveBeenCalled();
  });

  it("uses the prefixed audio context and closes after decode failure", async () => {
    const context = {
      decodeAudioData: vi.fn(async () => {
        throw new Error("bad audio");
      }),
      close: vi.fn(async () => undefined),
    };
    const WebkitAudioContext = vi.fn(function () {
      return context;
    });
    vi.stubGlobal("AudioContext", undefined);
    Object.defineProperty(globalThis, "webkitAudioContext", {
      configurable: true,
      value: WebkitAudioContext,
    });

    await expect(
      decodeAudioBuffer(audioFile("bad.wav")),
    ).rejects.toThrow("bad audio");
    expect(context.close).toHaveBeenCalled();
  });

  it("rejects when no audio context implementation is available", async () => {
    vi.stubGlobal("AudioContext", undefined);
    await expect(
      decodeAudioBuffer(audioFile()),
    ).rejects.toThrow("AudioContext is unavailable");
  });

  it("packages ordered frames without audio", async () => {
    const frames = [
      new File(["ten"], "frame_10.png"),
      new File(["two"], "frame_2.png"),
    ];

    const result = await packageFramesAndAudioToVideo(frames, null, 25);

    expect(Output).toHaveBeenCalledOnce();
    expect(CanvasSource).toHaveBeenCalledWith(mocks.canvas, {
      codec: "avc",
      bitrate: 6_000_000,
      latencyMode: "quality",
    });
    expect(AudioBufferSource).not.toHaveBeenCalled();
    expect(mocks.output.addVideoTrack).toHaveBeenCalledWith(
      mocks.videoSource,
      { frameRate: 25 },
    );
    expect(mocks.videoSource.add).toHaveBeenNthCalledWith(1, 0, 1 / 25);
    expect(mocks.videoSource.add).toHaveBeenNthCalledWith(2, 1 / 25, 1 / 25);
    expect(mocks.context2d.drawImage).toHaveBeenCalledTimes(2);
    expect(result.file).toMatchObject({
      type: "video/mp4",
    });
    expect(result.file.name).toMatch(/^generation-packaged-\d+\.mp4$/);
    expect(mocks.compatibility).toHaveBeenCalledWith({
      type: "video",
      duration: 2 / 25,
      fps: 25,
    });
  });

  it("adds audio and uses the longer audio duration", async () => {
    const decoded = { duration: 4 } as AudioBuffer;
    const context = {
      decodeAudioData: vi.fn(async () => decoded),
      close: vi.fn(async () => undefined),
    };
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        return context;
      }),
    );

    await packageFramesAndAudioToVideo(
      [new File(["frame"], "frame_1.png")],
      audioFile(),
      0,
    );

    expect(mocks.output.addAudioTrack).toHaveBeenCalledWith(mocks.audioSource);
    expect(mocks.audioSource.add).toHaveBeenCalledWith(decoded);
    expect(mocks.audioSource.close).toHaveBeenCalled();
    expect(mocks.videoSource.add).toHaveBeenCalledWith(0, 1);
    expect(mocks.compatibility).toHaveBeenCalledWith({
      type: "video",
      duration: 4,
      fps: 1,
    });
  });

  it("rejects empty frames and unavailable canvas contexts", async () => {
    await expect(packageFramesAndAudioToVideo([], null, 24)).rejects.toThrow(
      "No frame files were provided",
    );

    mocks.canvas.getContext.mockReturnValueOnce(null as never);
    await expect(
      packageFramesAndAudioToVideo(
        [new File(["frame"], "frame.png")],
        null,
        24,
      ),
    ).rejects.toThrow("Failed to acquire a 2D canvas context");
  });

  it("rejects a finalized output without a buffer", async () => {
    mocks.target.buffer = null;
    await expect(
      packageFramesAndAudioToVideo(
        [new File(["frame"], "frame.png")],
        null,
        24,
      ),
    ).rejects.toThrow("Packaged video output buffer is empty");
    expect(mocks.videoSource.close).toHaveBeenCalled();
    expect(mocks.output.finalize).toHaveBeenCalled();
  });
});
