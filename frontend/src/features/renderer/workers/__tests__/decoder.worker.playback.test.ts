import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A 10 fps, 2 s video. Each `canvases(start)` call opens a fresh iterator from
 * the frame at or before `start`, as mediabunny's CanvasSink does.
 */
const decoder = vi.hoisted(() => {
  const FPS = 10;
  const FRAME_COUNT = 20;
  const state = {
    iteratorStarts: [] as number[],
    returnedIterators: 0,
    hasVideoTrack: true,
    failAtFrame: null as number | null,
  };

  class Input {
    async getPrimaryVideoTrack() {
      return state.hasVideoTrack
        ? { canBeTransparent: async () => false }
        : null;
    }
    dispose() {}
  }

  class CanvasSink {
    canvases(start: number) {
      state.iteratorStarts.push(start);
      let index = Math.max(0, Math.floor(start * FPS + 1e-9));
      return {
        async next() {
          if (state.failAtFrame !== null && index === state.failAtFrame) {
            throw new Error("decode failed");
          }
          if (index >= FRAME_COUNT) return { done: true, value: undefined };
          const frame = {
            timestamp: index / FPS,
            duration: 1 / FPS,
            canvas: { frameIndex: index },
          };
          index += 1;
          return { done: false, value: frame };
        },
        async return() {
          state.returnedIterators += 1;
          return { done: true, value: undefined };
        },
      };
    }
  }

  class InputDisposedError extends Error {}
  class Source {}

  return {
    state,
    module: {
      ALL_FORMATS: [],
      BlobSource: Source,
      UrlSource: Source,
      CanvasSink,
      Input,
      InputDisposedError,
    },
  };
});

vi.mock("mediabunny", () => decoder.module);

type WorkerHandler = (event: MessageEvent) => Promise<void>;

interface FakeBitmap {
  source: unknown;
  close: ReturnType<typeof vi.fn>;
}

interface PostedMessage {
  type: string;
  bitmap?: FakeBitmap | null;
  [key: string]: unknown;
}

let posted: PostedMessage[];
let createImageBitmap: ReturnType<typeof vi.fn>;
let handler: WorkerHandler;

async function loadWorker(): Promise<WorkerHandler> {
  vi.resetModules();
  await import("../decoder.worker");
  return self.onmessage as unknown as WorkerHandler;
}

function send(data: unknown): Promise<void> {
  return handler(new MessageEvent("message", { data }));
}

async function prepareVideo(clipId = "clip") {
  await send({ type: "prepare", url: "blob:video", clipId, kind: "video" });
}

/** Renders `time` (seconds) and returns the frame index shown, or null. */
async function renderAt(time: number, clipId = "clip"): Promise<number | null> {
  const requestId = `req-${posted.length}-${time}`;
  await send({ type: "render", clipId, time, strict: true, requestId });
  // The worker answers from its render loop, which the handler does not await.
  const reply = await vi.waitFor(() => {
    const found = replyTo(requestId);
    if (!found) throw new Error(`no reply for ${requestId}`);
    return found;
  });
  const source = reply.bitmap?.source as { frameIndex: number } | undefined;
  return source?.frameIndex ?? null;
}

function replyTo(requestId: string): PostedMessage | undefined {
  return posted.find(
    (message) => message.type === "frame" && message.requestId === requestId,
  );
}

function bitmapSources(): number[] {
  return createImageBitmap.mock.calls.map(
    ([canvas]) => (canvas as { frameIndex: number }).frameIndex,
  );
}

describe("decoder worker playback", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    Object.assign(decoder.state, {
      iteratorStarts: [],
      returnedIterators: 0,
      hasVideoTrack: true,
      failAtFrame: null,
    });
    posted = [];
    vi.spyOn(globalThis, "postMessage").mockImplementation((message: unknown) => {
      posted.push(message as PostedMessage);
    });
    createImageBitmap = vi.fn(async (source: unknown) => ({
      source,
      close: vi.fn(),
    }));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    // Decoded canvases here are plain objects, so they take the
    // createImageBitmap path rather than transferToImageBitmap.
    vi.stubGlobal("OffscreenCanvas", class {});
    handler = await loadWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays sequential frames from one decoder iterator", async () => {
    await prepareVideo();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "ready", clipId: "clip", kind: "video" }),
    );

    expect(await renderAt(0)).toBe(0);
    expect(await renderAt(0.1)).toBe(1);
    expect(await renderAt(0.2)).toBe(2);
    expect(await renderAt(0.3)).toBe(3);

    expect(decoder.state.iteratorStarts).toEqual([0]);
  });

  it("decodes the next frame ahead during steady playback", async () => {
    await prepareVideo();
    await renderAt(0);
    await renderAt(0.1);
    // Stepping forward a frame prefetches frame 2 before it is requested.
    expect(bitmapSources()).toEqual([0, 1, 2]);

    expect(await renderAt(0.2)).toBe(2);
    // Frame 2 came from the prefetch; only frame 3 was decoded ahead now.
    expect(bitmapSources()).toEqual([0, 1, 2, 3]);
  });

  it("skips to the latest due frame when playback falls behind", async () => {
    await prepareVideo();
    await renderAt(0);

    expect(await renderAt(0.45)).toBe(4);
    expect(decoder.state.iteratorStarts).toEqual([0]);
  });

  it("shows the frame covering a time between two frame timestamps", async () => {
    await prepareVideo();
    await renderAt(0.1);

    // Callers request frame-snapped times, but an in-between time must still
    // resolve to the frame on screen at that moment.
    expect(await renderAt(0.15)).toBe(1);
    expect(await renderAt(0.2)).toBe(2);
  });

  it.each([
    ["backwards", 1.0, 0.3, 3],
    ["far forwards", 0, 1.5, 15],
  ])("reopens the decoder after seeking %s", async (_label, from, to, frame) => {
    await prepareVideo();
    await renderAt(from);

    expect(await renderAt(to)).toBe(frame);
    expect(decoder.state.iteratorStarts).toEqual([from, to]);
    expect(decoder.state.returnedIterators).toBe(1);
  });

  it("closes the iterator and drops prefetched frames on dispose", async () => {
    await prepareVideo();
    await renderAt(0);
    await renderAt(0.1);

    await send({ type: "dispose", clipId: "clip" });
    expect(decoder.state.returnedIterators).toBe(1);
    await vi.waitFor(() =>
      expect(
        (createImageBitmap.mock.results[2].value as Promise<FakeBitmap>).then(
          (bitmap) => bitmap.close.mock.calls.length,
        ),
      ).resolves.toBe(1),
    );

    // A render after dispose is answered rather than left hanging.
    await send({ type: "render", clipId: "clip", time: 0.2, requestId: "late" });
    expect(posted).toContainEqual(
      expect.objectContaining({
        requestId: "late",
        bitmap: null,
        reason: "missing-renderer",
      }),
    );
  });

  it("answers a failed decode with an error frame instead of hanging", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await prepareVideo();
    decoder.state.failAtFrame = 1;

    await send({ type: "render", clipId: "clip", time: 0, strict: true, requestId: "r" });

    await vi.waitFor(() => expect(replyTo("r")).toBeDefined());
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "frame",
        requestId: "r",
        bitmap: null,
        error: "Error: decode failed",
      }),
    );
  });

  it("reports a video without a video track", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    decoder.state.hasVideoTrack = false;

    await prepareVideo();

    expect(posted).toContainEqual(
      expect.objectContaining({ type: "error", message: "Error: No video track found" }),
    );
    expect(posted).not.toContainEqual(expect.objectContaining({ type: "ready" }));
  });

  it("renders still images by cloning one decoded bitmap", async () => {
    const file = new File(["png"], "still.png", { type: "image/png" });
    await send({
      type: "prepare",
      url: "blob:image",
      clipId: "still",
      kind: "image",
      file,
    });

    await send({ type: "render", clipId: "still", time: 0, requestId: "a" });
    await vi.waitFor(() => expect(replyTo("a")).toBeDefined());
    await send({ type: "render", clipId: "still", time: 5, requestId: "b" });
    await vi.waitFor(() => expect(replyTo("b")).toBeDefined());

    expect(createImageBitmap).toHaveBeenNthCalledWith(1, file);
    const decoded = (await createImageBitmap.mock.results[0].value) as FakeBitmap;
    // Each render clones the decoded source rather than transferring it.
    expect(createImageBitmap).toHaveBeenNthCalledWith(2, decoded);
    expect(createImageBitmap).toHaveBeenNthCalledWith(3, decoded);
    expect(
      posted.filter((message) => message.type === "frame" && message.bitmap),
    ).toHaveLength(2);
  });
});
