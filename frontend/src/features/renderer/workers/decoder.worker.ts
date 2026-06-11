import {
  Input,
  UrlSource,
  CanvasSink,
  ALL_FORMATS,
  BlobSource,
} from "mediabunny";
import type { WrappedCanvas } from "mediabunny";
import {
  isFrameTimestampAheadOfRequest,
  isFrameTimestampReady,
} from "../utils/frameTiming";

// --- Types ---
interface RenderOptions {
  width?: number;
  height?: number;
  fit?: "contain" | "cover" | "fill";
}

interface Renderer {
  init(url: string, options: RenderOptions, file?: File): Promise<void>;
  render(time: number): Promise<ImageBitmap | null>;
  dispose(): void;
}

interface PrefetchedBitmapFrame {
  timestamp: number;
  duration: number;
  bitmapPromise: Promise<ImageBitmap | null>;
}

type WorkerMessage =
  | {
      type: "prepare";
      url: string;
      clipId: string;
      kind: "video" | "image" | "mask_video";
      file?: File; // Optional local file
      width?: number;
      height?: number;
      fit?: "contain" | "cover" | "fill";
    }
  | {
      type: "render";
      time: number;
      clipId: string;
      transformTime?: number;
      strict?: boolean;
      requestId?: string;
    }
  | { type: "dispose"; clipId: string };

type TransformTime = number;
interface RenderRequest {
  time: number;
  clipId: string;
  transformTime?: TransformTime;
  strict?: boolean;
  requestId?: string;
}

// --- Video Renderer Strategy ---
class VideoRenderer implements Renderer {
  private static readonly PREFETCH_MAX_FORWARD_STEP_SECONDS = 0.25;

  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private videoIterator?: AsyncGenerator<WrappedCanvas, void, unknown>;
  private nextVideoFrame?: WrappedCanvas | null;
  private prefetchedBitmapFrame: PrefetchedBitmapFrame | null = null;
  private lastRequestTime: number | null = null;

  async init(url: string, options: RenderOptions, file?: File): Promise<void> {
    this.dispose();

    const source = file
      ? new BlobSource(file)
      : new UrlSource(url, { maxCacheSize: 16 * 1024 * 1024 });

    this.input = new Input({
      source,
      formats: ALL_FORMATS,
    });

    const videoTrack = await this.input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("No video track found");
    }

    this.sink = new CanvasSink(videoTrack, {
      poolSize: 5,
      alpha: await videoTrack.canBeTransparent(),
      ...options,
    });
  }

  async render(time: number): Promise<ImageBitmap | null> {
    if (!this.sink) return null;

    let frame: WrappedCanvas | null = null;
    let bitmap: ImageBitmap | null = null;
    const previousRequestTime = this.lastRequestTime;
    this.lastRequestTime = time;
    const isSmallForwardStep =
      previousRequestTime !== null &&
      time > previousRequestTime &&
      time - previousRequestTime <=
        VideoRenderer.PREFETCH_MAX_FORWARD_STEP_SECONDS;

    // 1. Check if we can reuse the iterator (Sequential Playback)
    const needsReset =
      !this.videoIterator ||
      !this.nextVideoFrame ||
      isFrameTimestampAheadOfRequest(this.nextVideoFrame.timestamp, time) ||
      this.nextVideoFrame.timestamp < time - 1.0; // Seek forwards (large gap)

    if (needsReset) {
      if (this.videoIterator) {
        void this.videoIterator.return();
      }
      this.clearPrefetchedBitmapFrame();
      this.videoIterator = this.sink.canvases(time);

      // Prime the iterator
      const first = (await this.videoIterator.next()).value;
      const second = (await this.videoIterator.next()).value;

      if (first) {
        frame = first;
      }
      this.nextVideoFrame = second ?? null;
    } else {
      // Sequential Update
      if (isFrameTimestampReady(this.nextVideoFrame!.timestamp, time)) {
        const result = await this.consumeNextFrame();
        frame = result.frame;
        bitmap = result.bitmap;
      } else {
        frame = null;
      }
    }

    // Catch up logic
    while (
      this.nextVideoFrame &&
      isFrameTimestampReady(this.nextVideoFrame.timestamp, time)
    ) {
      const result = await this.consumeNextFrame();
      if (bitmap) {
        bitmap.close();
        bitmap = null;
      }
      frame = result.frame;
      bitmap = result.bitmap;
    }

    if (frame && frame.canvas) {
      bitmap = await this.createBitmapFromFrame(frame);
    }

    if (isSmallForwardStep && this.videoIterator && this.nextVideoFrame) {
      this.prefetchNextBitmapFrame();
    }

    return bitmap;
  }

  dispose(): void {
    this.clearPrefetchedBitmapFrame();
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }
    if (this.videoIterator) {
      void this.videoIterator.return();
      this.videoIterator = undefined;
    }
    this.sink = null;
    this.nextVideoFrame = null;
    this.lastRequestTime = null;
  }

  private async consumeNextFrame(): Promise<{
    frame: WrappedCanvas | null;
    bitmap: ImageBitmap | null;
  }> {
    if (!this.videoIterator || !this.nextVideoFrame) {
      return { frame: null, bitmap: null };
    }

    const currentFrame = this.nextVideoFrame;
    const prefetchedBitmapFrame =
      this.takePrefetchedBitmapFrame(currentFrame);
    const nextResult = await this.videoIterator.next();
    this.nextVideoFrame = nextResult.value ?? null;

    if (!prefetchedBitmapFrame) {
      return { frame: currentFrame, bitmap: null };
    }

    const bitmap = await prefetchedBitmapFrame.bitmapPromise;
    if (!bitmap) {
      return { frame: currentFrame, bitmap: null };
    }

    return { frame: null, bitmap };
  }

  private prefetchNextBitmapFrame(): void {
    const frame = this.nextVideoFrame;
    if (!frame) {
      this.clearPrefetchedBitmapFrame();
      return;
    }

    if (
      this.prefetchedBitmapFrame &&
      this.isSameWrappedCanvasFrame(this.prefetchedBitmapFrame, frame)
    ) {
      return;
    }

    this.clearPrefetchedBitmapFrame();
    this.prefetchedBitmapFrame = {
      timestamp: frame.timestamp,
      duration: frame.duration,
      bitmapPromise: this.createBitmapFromFrame(frame).catch(() => null),
    };
  }

  private takePrefetchedBitmapFrame(
    frame: WrappedCanvas,
  ): PrefetchedBitmapFrame | null {
    const prefetchedBitmapFrame = this.prefetchedBitmapFrame;
    if (
      !prefetchedBitmapFrame ||
      !this.isSameWrappedCanvasFrame(prefetchedBitmapFrame, frame)
    ) {
      return null;
    }

    this.prefetchedBitmapFrame = null;
    return prefetchedBitmapFrame;
  }

  private clearPrefetchedBitmapFrame(): void {
    const prefetchedBitmapFrame = this.prefetchedBitmapFrame;
    this.prefetchedBitmapFrame = null;
    void prefetchedBitmapFrame?.bitmapPromise.then((bitmap) => {
      bitmap?.close();
    });
  }

  private isSameWrappedCanvasFrame(
    left: Pick<WrappedCanvas, "timestamp" | "duration">,
    right: Pick<WrappedCanvas, "timestamp" | "duration">,
  ): boolean {
    return left.timestamp === right.timestamp && left.duration === right.duration;
  }

  private async createBitmapFromFrame(
    frame: WrappedCanvas,
  ): Promise<ImageBitmap | null> {
    if (!frame.canvas) {
      return null;
    }

    if (frame.canvas instanceof OffscreenCanvas) {
      return frame.canvas.transferToImageBitmap();
    }

    return createImageBitmap(frame.canvas);
  }
}

// --- Image Renderer Strategy ---
class ImageRenderer implements Renderer {
  private sourceBitmap: ImageBitmap | null = null;

  async init(url: string, _options?: RenderOptions, file?: File): Promise<void> {
    this.dispose();
    try {
      const blob = file ?? await (await fetch(url)).blob();
      this.sourceBitmap = await createImageBitmap(blob);
    } catch (e) {
      console.error("ImageRenderer Init Error:", e);
      throw e;
    }
  }

  async render(): Promise<ImageBitmap | null> {
    if (!this.sourceBitmap) return null;
    // Clone bitmap
    return createImageBitmap(this.sourceBitmap);
  }

  dispose(): void {
    if (this.sourceBitmap) {
      this.sourceBitmap.close();
      this.sourceBitmap = null;
    }
  }
}

// --- Worker State ---
const renderers = new Map<string, Renderer>();
const rendererKinds = new Map<string, "video" | "image" | "mask_video">();
const initPromises = new Map<string, Promise<void>>();
let isRendering = false;
let pendingRender: RenderRequest | null = null;

// --- Helper: Message Processing ---
const cleanupRenderer = (clipId: string) => {
  const renderer = renderers.get(clipId);
  if (renderer) {
    renderer.dispose();
    renderers.delete(clipId);
  }
  rendererKinds.delete(clipId);
  initPromises.delete(clipId);
  if (pendingRender?.clipId === clipId) {
    pendingRender = null;
  }
};

const processRender = async (request: RenderRequest) => {
  const { time, clipId, transformTime, strict, requestId } = request;
  const renderer = renderers.get(clipId);
  const ctx = self as DedicatedWorkerGlobalScope;

  if (!renderer) {
    // Safety: If no renderer exists, send null so main thread doesn't hang
    ctx.postMessage({
      type: "frame",
      bitmap: null,
      time,
      clipId,
      transformTime,
      requestId,
    });
    return;
  }

  try {
    const bitmap = await renderer.render(time);

    // FIX: Always reply, even if bitmap is null
    if (bitmap) {
      ctx.postMessage(
        {
          type: "frame",
          bitmap,
          time,
          clipId,
          transformTime,
          requestId,
        },
        [bitmap],
      );
    } else if (strict) {
      // IMPORTANT: Send null frame to unblock ExportRenderer (only if strict mode)
      ctx.postMessage({
        type: "frame",
        bitmap: null,
        time,
        clipId,
        transformTime,
        requestId,
      });
    }
  } catch (err) {
    const msg = String(err);
    if (
      msg.includes("InputDisposedError") ||
      msg.includes("Input has been disposed")
    ) {
      // If disposed, we should still probably unlock the thread if it was waiting
      ctx.postMessage({
        type: "frame",
        bitmap: null,
        time,
        clipId,
        transformTime,
        requestId,
        error: "disposed",
      });
      return;
    }
    console.error(`Render Error [${clipId}]:`, err);

    // Send null on error to prevent hang
    ctx.postMessage({
      type: "frame",
      bitmap: null,
      time,
      clipId,
      transformTime,
      requestId,
      error: msg,
    });
  }
};

const loop = async (initialRequest: RenderRequest) => {
  isRendering = true;
  let nextRequest: RenderRequest | null = initialRequest;

  while (nextRequest !== null) {
    await processRender(nextRequest);

    if (pendingRender !== null) {
      nextRequest = pendingRender;
      pendingRender = null;
    } else {
      nextRequest = null;
    }
  }
  isRendering = false;
};


// --- Message Handler ---
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type } = e.data;

  try {
    switch (type) {
      case "prepare": {
        const { url, clipId, kind, width, height, fit, file } =
          e.data as Extract<WorkerMessage, { type: "prepare" }>;

        if (renderers.has(clipId)) {
          const initPromise = initPromises.get(clipId);
          if (initPromise) {
            await initPromise;
          }
          self.postMessage({
            type: "ready",
            clipId,
            kind: rendererKinds.get(clipId) ?? kind,
          });
          return;
        }

        let renderer: Renderer | null = null;
        if (kind === "video" || kind === "mask_video") {
          renderer = new VideoRenderer();
        } else if (kind === "image") {
          renderer = new ImageRenderer();
        } else {
          console.warn("Unknown kind:", kind);
          return;
        }

        renderers.set(clipId, renderer);
        rendererKinds.set(clipId, kind);
        const promise = renderer.init(url, { width, height, fit }, file);
        initPromises.set(clipId, promise);

        try {
          await promise;
          self.postMessage({ type: "ready", clipId, kind });
        } catch (err) {
          cleanupRenderer(clipId);
          throw err;
        }
        break;
      }

      case "render": {
        const { clipId, time, transformTime, strict, requestId } =
          e.data as Extract<WorkerMessage, { type: "render" }>;

        const initPromise = initPromises.get(clipId);
        if (initPromise) {
          await initPromise;
        }

        if (!renderers.has(clipId)) {
          // Early exit if renderer missing (prevent ghost threads)
          // Also notify main thread to unblock
          (self as DedicatedWorkerGlobalScope).postMessage({
            type: "frame",
            bitmap: null,
            time,
            clipId,
            transformTime,
            requestId,
          });
          return;
        }

        const renderRequest = {
          time,
          clipId,
          transformTime,
          strict,
          requestId,
        };
        if (isRendering) {
          pendingRender = renderRequest;
        } else {
          void loop(renderRequest);
        }
        break;
      }

      case "dispose": {
        const { clipId } = e.data as Extract<
          WorkerMessage,
          { type: "dispose" }
        >;
        cleanupRenderer(clipId);
        break;
      }
    }
  } catch (err) {
    console.error("Worker Error:", err);
    self.postMessage({ type: "error", message: String(err) });
  }
};
