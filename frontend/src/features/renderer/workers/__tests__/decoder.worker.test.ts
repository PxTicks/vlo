import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A decoder whose container probe never settles until the Input is disposed —
// the window in which a clip can be disposed mid-prepare.
vi.mock("mediabunny", () => {
  class InputDisposedError extends Error {
    constructor() {
      super("Input has been disposed.");
      this.name = "InputDisposedError";
    }
  }

  class Input implements Partial<import("mediabunny").Input> {
    private rejectPending: ((err: Error) => void) | null = null;

    getPrimaryVideoTrack(): Promise<never> {
      return new Promise((_, reject) => {
        this.rejectPending = reject;
      });
    }

    dispose(): void {
      this.rejectPending?.(new InputDisposedError());
      this.rejectPending = null;
    }
  }

  class Source {}

  return {
    ALL_FORMATS: [],
    BlobSource: Source,
    CanvasSink: class {},
    Input,
    InputDisposedError,
    UrlSource: Source,
  };
});

type WorkerHandler = (event: MessageEvent) => Promise<void>;

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

async function loadWorker(): Promise<WorkerHandler> {
  vi.resetModules();
  await import("../decoder.worker");
  const handler = self.onmessage;
  if (!handler) throw new Error("decoder worker did not install onmessage");
  return handler as unknown as WorkerHandler;
}

function send(handler: WorkerHandler, data: unknown): Promise<void> {
  return handler(new MessageEvent("message", { data }));
}

describe("decoder worker disposal", () => {
  let posted: PostedMessage[];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Holds back the worker's boot announcement, which is not under test.
    vi.useFakeTimers();
    posted = [];
    vi.spyOn(globalThis, "postMessage").mockImplementation(
      (message: unknown) => {
        posted.push(message as PostedMessage);
      },
    );
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("treats a dispose during prepare as a cancellation, not a worker error", async () => {
    const handler = await loadWorker();

    const prepared = send(handler, {
      type: "prepare",
      url: "blob:clip-a",
      clipId: "clip-a",
      kind: "video",
    });
    const rendered = send(handler, {
      type: "render",
      clipId: "clip-a",
      time: 0,
      strict: true,
      requestId: "req-1",
    });
    await send(handler, { type: "dispose", clipId: "clip-a" });
    await Promise.all([prepared, rendered]);

    // An "error" message is broadcast to every lease on a pooled worker.
    expect(posted.filter((message) => message.type === "error")).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    // The render queued behind the cancelled prepare is still answered.
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "frame",
        clipId: "clip-a",
        requestId: "req-1",
        bitmap: null,
      }),
    );
  });

  it("does not let a cancelled prepare tear down the renderer that replaced it", async () => {
    const handler = await loadWorker();

    const firstPrepare = send(handler, {
      type: "prepare",
      url: "blob:clip-a",
      clipId: "clip-a",
      kind: "video",
    });
    // Dispatched back to back, so the re-prepare lands before the first
    // prepare's rejection is handled.
    void send(handler, { type: "dispose", clipId: "clip-a" });
    void send(handler, {
      type: "prepare",
      url: "blob:clip-a",
      clipId: "clip-a",
      kind: "video",
    });
    await firstPrepare;

    await send(handler, { type: "ping", pingId: "ping-1" });
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "worker-health",
        event: "pong",
        detail: expect.objectContaining({ rendererCount: 1 }),
      }),
    );
  });
});
