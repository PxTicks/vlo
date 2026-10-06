import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application, Texture } from "pixi.js";
import { ExportFileTarget } from "../ExportFileTarget";
import type { ExportDiagnostic } from "../exportDiagnostics";
import {
  TextureOutputEncoder,
  type OutputVideoDefinition,
} from "../TextureOutputEncoder";

/**
 * Each CanvasSource.add() returns a manually-resolvable promise so a test can
 * observe encoder backpressure: real mediabunny resolves this once the encoder
 * is ready for more frames. The VideoSample snapshot is synchronous in
 * production, so deferring this promise is safe — these tests assert the
 * encoder defers it (pipelining) but still bounds + drains the queue.
 */
interface DeferredAdd {
  resolve: () => void;
  reject: (reason: unknown) => void;
  promise: Promise<void>;
}
interface ColorTaggedVideoEncoderConfig extends VideoEncoderConfig {
  colorSpace?: VideoColorSpaceInit;
}
const addCalls: DeferredAdd[] = [];
const mp4Options: Array<{ fastStart: false | "in-memory" }> = [];
const outputs: Array<{ finalize: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = [];
const canvasSourceConfigs: Array<{
  codec?: string;
  alpha?: "discard" | "keep";
  keyFrameInterval?: number;
  onEncoderConfig?: (config: VideoEncoderConfig) => void;
  onEncodedPacket?: (
    packet: unknown,
    metadata: EncodedVideoChunkMetadata | undefined,
  ) => void;
}> = [];

vi.mock("pixi.js", () => ({
  Container: class {
    addChild = vi.fn();
    destroy = vi.fn();
  },
  Sprite: class {
    anchor = { set: vi.fn() };
  },
}));

vi.mock("../../utils/outputTransformStack", () => ({
  applyOutputTransformStack: vi.fn(),
}));

vi.mock("mediabunny", () => ({
  Output: class {
    constructor() { outputs.push(this); }
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    cancel = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockResolvedValue(undefined);
  },
  Mp4OutputFormat: class {
    constructor(options: { fastStart: false | "in-memory" }) { mp4Options.push(options); }
  },
  WebMOutputFormat: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(1);
  },
  StreamTarget: class {},
  CanvasSource: class {
    constructor(_canvas: HTMLCanvasElement, config: (typeof canvasSourceConfigs)[number]) {
      canvasSourceConfigs.push(config);
    }
    add = vi.fn(() => {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      addCalls.push({ resolve, reject, promise });
      return promise;
    });
    close = vi.fn().mockResolvedValue(undefined);
  },
  AudioBufferSource: class {
    add = vi.fn();
    close = vi.fn();
  },
}));

const flushMicrotasks = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Resolves true once `promise` settles, false if it is still pending. */
function settled(promise: Promise<unknown>): { isDone: () => boolean } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { isDone: () => done };
}

describe("TextureOutputEncoder encode backpressure window", () => {
  const app = {
    canvas: {} as HTMLCanvasElement,
    renderer: { render: vi.fn() },
  } as unknown as Application;
  const texture = {} as unknown as Texture;
  const definition: OutputVideoDefinition = { id: "video", format: "mp4" };

  beforeEach(() => {
    addCalls.length = 0;
    mp4Options.length = 0;
    outputs.length = 0;
    canvasSourceConfigs.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function fileDestination() {
    const stream = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const fileHandle = { createWritable: vi.fn().mockResolvedValue(stream) } as unknown as FileSystemFileHandle;
    return { stream, fileHandle };
  }

  it("streams disk MP4 and reports a file output only after commit", async () => {
    const { stream, fileHandle } = fileDestination();
    const phases: string[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }], {
      onPhaseChange: (phase) => phases.push(phase),
    });
    await encoder.start();
    expect(mp4Options[0].fastStart).toBe(false);
    expect(stream.close).not.toHaveBeenCalled();
    const result = await encoder.finalize();
    expect(result.blobs).toEqual({});
    expect(result.files).toEqual({ video: fileHandle });
    expect(stream.close).toHaveBeenCalledOnce();
    expect(phases).toEqual(["finalizing", "saving"]);
    encoder.dispose();
    expect(stream.abort).not.toHaveBeenCalled();
  });

  it("discards earlier files when a later destination fails to open", async () => {
    const { stream, fileHandle } = fileDestination();
    const badHandle = { createWritable: vi.fn().mockRejectedValue(new Error("Permission lost")) } as unknown as FileSystemFileHandle;
    const encoder = new TextureOutputEncoder(app, 30, [
      { ...definition, fileHandle }, { id: "other", fileHandle: badHandle },
    ]);
    await expect(encoder.start()).rejects.toThrow("Permission lost");
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(outputs[0].cancel).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("uses the same commit and cancellation rules for a caller-owned stream", async () => {
    const { stream } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [
      { ...definition, outputTarget: new ExportFileTarget(stream) },
    ]);
    await encoder.start();
    expect(mp4Options[0].fastStart).toBe(false);
    const result = await encoder.finalize();
    expect(result.blobs).toEqual({});
    expect(result.files).toEqual({});
    expect(result.streamedOutputIds).toEqual(["video"]);
    expect(stream.close).toHaveBeenCalledOnce();
    await encoder.abort();
    expect(stream.abort).not.toHaveBeenCalled();
    encoder.dispose();
  });

  it("does not report a streamed artifact when sealing fails", async () => {
    const { stream } = fileDestination();
    stream.close.mockRejectedValueOnce(new Error("Stream disk full"));
    const encoder = new TextureOutputEncoder(app, 30, [
      { ...definition, outputTarget: new ExportFileTarget(stream) },
    ]);
    await encoder.start();
    await expect(encoder.finalize()).rejects.toThrow("Stream disk full");
    await encoder.abort();
    expect(stream.abort).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("discards a file created after cancellation was requested", async () => {
    const { stream, fileHandle } = fileDestination();
    let opened!: (stream: FileSystemWritableFileStream) => void;
    vi.mocked(fileHandle.createWritable).mockImplementationOnce(() => new Promise((resolve) => { opened = resolve; }));
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    const starting = encoder.start();
    await encoder.abort();
    opened(stream as unknown as FileSystemWritableFileStream);
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    encoder.dispose();
  });

  it("cancels while waiting for the encoder drain without committing", async () => {
    const { stream, fileHandle } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    await encoder.start();
    await encoder.addTextureFrame(texture, 0, 1 / 30);
    const finalizing = encoder.finalize();
    const rejected = expect(finalizing).rejects.toMatchObject({ name: "AbortError" });
    await encoder.abort();
    await rejected;
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(outputs[0].cancel).toHaveBeenCalledOnce();
    addCalls[0].resolve();
    encoder.dispose();
  });

  it("does not commit when mux finalization fails", async () => {
    const { stream, fileHandle } = fileDestination();
    const diagnostics: ExportDiagnostic[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }], {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await encoder.start();
    outputs[0].finalize.mockRejectedValueOnce(new Error("Write failed"));
    await expect(encoder.finalize()).rejects.toThrow("Write failed");
    expect(diagnostics.at(-1)).toMatchObject({
      kind: "finishing", stage: "mux-finalize", outputId: "video", state: "started",
    });
    await encoder.abort();
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.abort).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("propagates a failed file commit", async () => {
    const { stream, fileHandle } = fileDestination();
    const encoder = new TextureOutputEncoder(app, 30, [{ ...definition, fileHandle }]);
    await encoder.start();
    stream.close.mockRejectedValueOnce(new Error("Disk full"));
    await expect(encoder.finalize()).rejects.toThrow("Disk full");
    await encoder.abort();
    expect(stream.abort).toHaveBeenCalledOnce();
    encoder.dispose();
  });

  it("does not block while in-flight frames fit the window", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 2,
    });
    await encoder.start();

    const f0 = settled(encoder.addTextureFrame(texture, 0, 1 / 30));
    const f1 = settled(encoder.addTextureFrame(texture, 1, 1 / 30));
    await flushMicrotasks();

    // Window of 2 (single output) → first two submissions never await their
    // own encode promise, so both addTextureFrame calls settle immediately.
    expect(f0.isDone()).toBe(true);
    expect(f1.isDone()).toBe(true);
    expect(addCalls).toHaveLength(2);
  });

  it("holds rendering once the encoder falls far behind, until a packet returns", async () => {
    // A window this large never awaits add() itself: only the unencoded bound
    // can hold the producer, as with an encoder that accepts frames eagerly.
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 1000,
    });
    await encoder.start();

    // The first packet shows the pipeline is flowing; 61 more then exceed 60.
    await encoder.addTextureFrame(texture, 0, 1 / 30);
    canvasSourceConfigs[0].onEncodedPacket?.({}, undefined);
    for (let frame = 1; frame <= 60; frame += 1) {
      await encoder.addTextureFrame(texture, frame / 30, 1 / 30);
    }
    const held = settled(encoder.addTextureFrame(texture, 61 / 30, 1 / 30));
    await flushMicrotasks();
    expect(held.isDone()).toBe(false);

    canvasSourceConfigs[0].onEncodedPacket?.({}, undefined);
    await flushMicrotasks();
    expect(held.isDone()).toBe(true);
    encoder.dispose();
  });

  // Times out at the default 5 s when the full suite runs in parallel on a
  // busy machine (the suite polls a window that only the first packet
  // opens); the case itself passes in well under a second in isolation.
  it("does not hold rendering before the encoder's first packet", { timeout: 30_000 }, async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 1000,
    });
    await encoder.start();
    for (let frame = 0; frame < 200; frame += 1) {
      const added = settled(encoder.addTextureFrame(texture, frame / 30, 1 / 30));
      await flushMicrotasks();
      expect(added.isDone()).toBe(true);
    }
    encoder.dispose();
  });

  it("is not released by packets from an unrelated output", async () => {
    // Video plus mask: two encoders, one slow. A mask packet says nothing
    // about the video encoder, and must neither release nor widen its bound.
    const encoder = new TextureOutputEncoder(app, 30, [
      definition,
      { id: "mask", format: "mp4", includeAudio: false },
    ], { encodeQueueSize: 1000 });
    await encoder.start();
    const [video, mask] = canvasSourceConfigs;

    await encoder.addTextureFrame(texture, 0, 1 / 30);
    video.onEncodedPacket?.({}, undefined);
    mask.onEncodedPacket?.({}, undefined);
    for (let frame = 1; frame <= 60; frame += 1) {
      await encoder.addTextureFrame(texture, frame / 30, 1 / 30);
      mask.onEncodedPacket?.({}, undefined);
    }
    const held = settled(encoder.addTextureFrame(texture, 61 / 30, 1 / 30));
    await flushMicrotasks();
    expect(held.isDone()).toBe(false);

    for (let packet = 0; packet < 5; packet += 1) {
      mask.onEncodedPacket?.({}, undefined);
      await flushMicrotasks();
    }
    expect(held.isDone()).toBe(false);

    video.onEncodedPacket?.({}, undefined);
    await flushMicrotasks();
    expect(held.isDone()).toBe(true);

    // The bound is still 60: one frame past it holds again.
    const pending = encoder.addTextureFrame(texture, 62 / 30, 1 / 30);
    // Observed through a handled copy: `settled` would otherwise leave its own
    // derived promise to reject unobserved when the encoder is disposed.
    const heldAgain = settled(pending.catch(() => undefined));
    await flushMicrotasks();
    expect(heldAgain.isDone()).toBe(false);
    // Disposing cancels the render that is still waiting on the encoder.
    const cancelled = expect(pending).rejects.toThrow("Render cancelled");
    encoder.dispose();
    await cancelled;
  });

  it("widens the bound instead of deadlocking an encoder that buffers past it", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextureOutputEncoder(app, 30, [definition], {
        encodeQueueSize: 1000,
      });
      await encoder.start();
      await encoder.addTextureFrame(texture, 0, 1 / 30);
      canvasSourceConfigs[0].onEncodedPacket?.({}, undefined);
      for (let frame = 1; frame <= 60; frame += 1) {
        await encoder.addTextureFrame(texture, frame / 30, 1 / 30);
      }
      const held = settled(encoder.addTextureFrame(texture, 61 / 30, 1 / 30));
      await vi.advanceTimersByTimeAsync(1999);
      expect(held.isDone()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(held.isDone()).toBe(true);

      // The next frames fit the doubled bound, so they do not stall again.
      const next = settled(encoder.addTextureFrame(texture, 62 / 30, 1 / 30));
      await vi.advanceTimersByTimeAsync(0);
      expect(next.isDone()).toBe(true);
      encoder.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("configures WebM caches to retain alpha side data", async () => {
    const encoder = new TextureOutputEncoder(
      app,
      30,
      [
        {
          id: "composite",
          format: "webm",
          includeAudio: false,
          keyFrameInterval: 1,
        },
      ],
      { encodeQueueSize: 1 },
    );

    await encoder.start();

    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "vp9",
      alpha: "keep",
      keyFrameInterval: 1,
    });
    encoder.dispose();
  });

  it("requests no-preference hardware acceleration for both VP9 and AVC", async () => {
    // `prefer-hardware` is not a hint as far as mediabunny is concerned: it
    // fails closed on `isConfigSupported`, so a machine with no hardware
    // encoder for the codec gets a hard export failure instead of the software
    // encoder. Hardware VP9 encode is uncommon, so this broke WebM composite
    // bakes while the H.264 path kept working and hid it.
    const webmEncoder = new TextureOutputEncoder(app, 30, [
      { id: "composite", format: "webm", includeAudio: false },
    ]);
    await webmEncoder.start();
    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "vp9",
      hardwareAcceleration: "no-preference",
    });
    webmEncoder.dispose();

    canvasSourceConfigs.length = 0;

    const mp4Encoder = new TextureOutputEncoder(app, 30, [definition]);
    await mp4Encoder.start();
    expect(canvasSourceConfigs[0]).toMatchObject({
      codec: "avc",
      hardwareAcceleration: "no-preference",
    });
    mp4Encoder.dispose();
  });

  it("tags AVC encoder and MP4 decoder metadata as BT.709/sRGB", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition]);
    await encoder.start();

    const config = {} as ColorTaggedVideoEncoderConfig;
    canvasSourceConfigs[0].onEncoderConfig?.(config);
    expect(config.colorSpace).toEqual({
      primaries: "bt709",
      transfer: "iec61966-2-1",
      matrix: "bt709",
      fullRange: false,
    });

    const metadata = {
      decoderConfig: {},
    } as EncodedVideoChunkMetadata;
    canvasSourceConfigs[0].onEncodedPacket?.({}, metadata);
    expect(metadata.decoderConfig?.colorSpace).toEqual(config.colorSpace);
  });

  it("throttles once the window is full and resumes when the oldest drains", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 2,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    const f2 = settled(encoder.addTextureFrame(texture, 2, 1 / 30));
    await flushMicrotasks();

    // Third frame exceeds the window of 2 → it awaits the oldest encode.
    expect(f2.isDone()).toBe(false);

    addCalls[0].resolve();
    await flushMicrotasks();

    expect(f2.isDone()).toBe(true);
  });

  it("finalize() awaits every outstanding encode before closing", async () => {
    const diagnostics: ExportDiagnostic[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 4,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    await flushMicrotasks();

    const fin = settled(encoder.finalize());
    await flushMicrotasks();

    // Two encodes still in flight → finalize must not resolve yet.
    expect(fin.isDone()).toBe(false);
    expect(diagnostics).toContainEqual({ kind: "finishing", stage: "encoder-drain", state: "started" });
    expect(diagnostics.some((event) => event.kind === "finishing" && event.state === "completed")).toBe(false);

    addCalls.forEach((call) => call.resolve());
    await flushMicrotasks();

    expect(fin.isDone()).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "finishing", stage: "encoder-drain", state: "completed" }));
  });

  it("reports the configured codec and submission-to-packet latency", async () => {
    const diagnostics: ExportDiagnostic[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await encoder.start();
    const config: VideoEncoderConfig = { codec: "avc1.42001f", width: 320, height: 180 };
    canvasSourceConfigs[0].onEncoderConfig?.(config);
    expect(diagnostics[0]).toMatchObject({ kind: "encoder-config", config: {
      codec: config.codec, colorSpace: { primaries: "bt709" },
    } });
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(100);
      await encoder.addTextureFrame(texture, 1 / 30, 1 / 30);
      clock.mockReturnValue(140);
      // WebCodecs timestamps are quantized to microseconds.
      canvasSourceConfigs[0].onEncodedPacket?.({ timestamp: 0.033333, byteLength: 42 }, undefined);
      expect(diagnostics.at(-1)).toEqual({ kind: "video-packet", outputId: "video",
        timestamp: 0.033333, bytes: 42, submissionToPacketMilliseconds: 40 });
      addCalls[0].resolve();
      await encoder.finalize();
    } finally {
      clock.mockRestore();
      encoder.dispose();
    }
  });

  it.each([
    { name: "precise", packetTime: (time: number) => time },
    { name: "truncated", packetTime: (time: number) => Math.trunc(time * 1_000_000) / 1_000_000 },
    { name: "rounded", packetTime: (time: number) => Math.round(time * 1_000_000) / 1_000_000 },
  ])("matches $name packet timestamps even when packets arrive out of order", async ({ packetTime }) => {
    const diagnostics: ExportDiagnostic[] = [];
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const clock = vi.spyOn(performance, "now");
    try {
      await encoder.start();
      // 2/30 rounds up to 66667 us but can return as 66666 us. Later
      // timestamps also exercise floating-point conversion at second boundaries.
      const frames = [0, 1, 2, 173, 3599];
      for (const frame of frames) {
        clock.mockReturnValue(100 + frame);
        await encoder.addTextureFrame(texture, frame / 30, 1 / 30);
        addCalls.at(-1)!.resolve();
      }
      clock.mockReturnValue(4000);
      canvasSourceConfigs[0].onEncodedPacket?.({ timestamp: packetTime(2 / 30) - 0.000002, byteLength: 42 }, undefined);
      expect(diagnostics.at(-1)).toMatchObject({ submissionToPacketMilliseconds: null });
      for (const frame of [...frames].reverse()) {
        canvasSourceConfigs[0].onEncodedPacket?.({ timestamp: packetTime(frame / 30), byteLength: 42 }, undefined);
      }
      expect(diagnostics.filter((event) => event.kind === "video-packet")
        .map((event) => event.submissionToPacketMilliseconds))
        .toEqual([null, ...[...frames].reverse().map((frame) => 3900 - frame)]);

      // Consumed or genuinely unknown timestamps must not borrow another sample.
      for (const timestamp of [packetTime(2 / 30), 10]) {
        canvasSourceConfigs[0].onEncodedPacket?.({ timestamp, byteLength: 42 }, undefined);
        expect(diagnostics.at(-1)).toMatchObject({ submissionToPacketMilliseconds: null });
      }
      await encoder.finalize();
    } finally {
      clock.mockRestore();
      encoder.dispose();
    }
  });

  it("finalize observes every encode before re-throwing the first failure", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 4,
    });
    await encoder.start();

    // Three in flight (within the window, so no backpressure await).
    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    void encoder.addTextureFrame(texture, 2, 1 / 30);
    await flushMicrotasks();

    // The OLDEST encode fails first. A sequential `for await` drain would throw
    // here and abandon the still-pending later encodes; the all-settled drain
    // must instead keep waiting until every encode has settled.
    addCalls[0].reject(new Error("encode-0 boom"));

    let state: "pending" | "fulfilled" | "rejected" = "pending";
    let caught: unknown;
    const fin = encoder.finalize().then(
      () => {
        state = "fulfilled";
      },
      (error: unknown) => {
        state = "rejected";
        caught = error;
      },
    );
    await flushMicrotasks();
    // Encodes 1 & 2 are still in flight, so the drain must not have settled.
    expect(state).toBe("pending");

    // Settling the later encodes lets the drain complete and re-surface the
    // oldest failure — proving none were abandoned when the oldest rejected.
    addCalls[1].resolve();
    addCalls[2].resolve();
    await fin;
    expect(state).toBe("rejected");
    expect((caught as Error).message).toBe("encode-0 boom");
  });

  it("backpressure re-surfaces the failure of the oldest encode", async () => {
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 1,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    await flushMicrotasks();

    // Oldest encode fails; the next frame trips backpressure and must rethrow.
    addCalls[0].reject(new Error("oldest boom"));
    await flushMicrotasks();

    await expect(encoder.addTextureFrame(texture, 1, 1 / 30)).rejects.toThrow(
      "oldest boom",
    );
  });
});
