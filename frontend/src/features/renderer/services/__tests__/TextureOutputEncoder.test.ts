import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application, Texture } from "pixi.js";
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
const addCalls: DeferredAdd[] = [];

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
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockResolvedValue(undefined);
  },
  Mp4OutputFormat: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(1);
  },
  StreamTarget: class {},
  CanvasSource: class {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    const encoder = new TextureOutputEncoder(app, 30, [definition], {
      encodeQueueSize: 4,
    });
    await encoder.start();

    void encoder.addTextureFrame(texture, 0, 1 / 30);
    void encoder.addTextureFrame(texture, 1, 1 / 30);
    await flushMicrotasks();

    const fin = settled(encoder.finalize());
    await flushMicrotasks();

    // Two encodes still in flight → finalize must not resolve yet.
    expect(fin.isDone()).toBe(false);

    addCalls.forEach((call) => call.resolve());
    await flushMicrotasks();

    expect(fin.isDone()).toBe(true);
  });

  it("does not leak an unhandled rejection when a non-oldest encode fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    const onNodeUnhandled = (reason: unknown) => unhandled.push(reason);
    window.addEventListener("unhandledrejection", onUnhandled);
    process.on("unhandledRejection", onNodeUnhandled);

    try {
      const encoder = new TextureOutputEncoder(app, 30, [definition], {
        encodeQueueSize: 4,
      });
      await encoder.start();

      void encoder.addTextureFrame(texture, 0, 1 / 30);
      void encoder.addTextureFrame(texture, 1, 1 / 30);
      await flushMicrotasks();

      // The newer (non-oldest) encode fails first while still queued.
      addCalls[1].reject(new Error("encode-1 boom"));
      await flushMicrotasks();

      expect(unhandled).toHaveLength(0);

      // Resolve the rest so finalize can drain and re-surface the captured
      // failure after the whole queue settles.
      addCalls[0].resolve();
      await expect(encoder.finalize()).rejects.toThrow("encode-1 boom");
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
      process.off("unhandledRejection", onNodeUnhandled);
    }
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
