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
import type { DecoderRequestDiagnostics } from "../utils/decoderDiagnostics";
import {
  clearPendingRenderRequest,
  type CompleteRenderRequestResult,
  completeRenderRequest,
  createRenderRequestQueueState,
  enqueueRenderRequest,
} from "./renderRequestQueue";

// --- Types ---
interface RenderOptions {
  width?: number;
  height?: number;
  fit?: "contain" | "cover" | "fill";
}

interface Renderer {
  init(
    url: string,
    options: RenderOptions,
    file?: File,
    diagnostics?: DecoderRequestDiagnostics,
  ): Promise<void>;
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
      type: "ping";
      pingId: string;
    }
  | {
      type: "prepare";
      url: string;
      clipId: string;
      kind: "video" | "image" | "mask_video";
      file?: File; // Optional local file
      width?: number;
      height?: number;
      fit?: "contain" | "cover" | "fill";
      diagnostics?: DecoderRequestDiagnostics;
    }
  | {
      type: "render";
      time: number;
      clipId: string;
      transformTime?: number;
      strict?: boolean;
      requestId?: string;
      diagnostics?: DecoderRequestDiagnostics;
    }
  | { type: "dispose"; clipId: string };

type TransformTime = number;
interface RenderRequest {
  time: number;
  clipId: string;
  transformTime?: TransformTime;
  strict?: boolean;
  requestId?: string;
  diagnostics?: DecoderRequestDiagnostics;
}

const workerBootedAtMs = performance.now();

function postWorkerHealth(
  event: "boot" | "pong",
  detail: Record<string, unknown> = {},
): void {
  const pingId = typeof detail.pingId === "string" ? detail.pingId : undefined;
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "worker-health",
    event,
    workerElapsedMs: performance.now() - workerBootedAtMs,
    ...(pingId ? { pingId } : {}),
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  });
}

setTimeout(() => {
  postWorkerHealth("boot");
}, 0);

function postDecoderDiagnostic(
  diagnostics: DecoderRequestDiagnostics | undefined,
  phase: string,
  startedAtMs: number,
  detail?: Record<string, unknown>,
): void {
  if (!diagnostics) {
    return;
  }

  const nowMs = performance.now();
  (self as DedicatedWorkerGlobalScope).postMessage({
    ...diagnostics,
    type: "diagnostic",
    phase,
    workerElapsedMs: nowMs - startedAtMs,
    detail,
  });
}

function getUrlScheme(url: string): string {
  const separatorIndex = url.indexOf(":");
  return separatorIndex > 0 ? url.slice(0, separatorIndex) : "relative";
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

  async init(
    url: string,
    options: RenderOptions,
    file?: File,
    diagnostics?: DecoderRequestDiagnostics,
  ): Promise<void> {
    const initStartedAtMs = performance.now();
    this.dispose();

    postDecoderDiagnostic(diagnostics, "worker:video:init:start", initStartedAtMs, {
      hasFile: !!file,
      fileSizeMB: file ? Number((file.size / (1024 * 1024)).toFixed(2)) : null,
      sourceScheme: file ? "blob-file" : getUrlScheme(url),
    });

    const source = file
      ? new BlobSource(file)
      : new UrlSource(url, { maxCacheSize: 16 * 1024 * 1024 });
    postDecoderDiagnostic(
      diagnostics,
      "worker:video:source-created",
      initStartedAtMs,
    );

    this.input = new Input({
      source,
      formats: ALL_FORMATS,
    });
    postDecoderDiagnostic(
      diagnostics,
      "worker:video:input-created",
      initStartedAtMs,
    );

    const trackStartedAtMs = performance.now();
    const videoTrack = await this.input.getPrimaryVideoTrack();
    postDecoderDiagnostic(
      diagnostics,
      "worker:video:primary-track",
      initStartedAtMs,
      { phaseMs: Number((performance.now() - trackStartedAtMs).toFixed(1)) },
    );
    if (!videoTrack) {
      throw new Error("No video track found");
    }

    const alphaStartedAtMs = performance.now();
    const alpha = await videoTrack.canBeTransparent();
    postDecoderDiagnostic(
      diagnostics,
      "worker:video:alpha-capability",
      initStartedAtMs,
      { phaseMs: Number((performance.now() - alphaStartedAtMs).toFixed(1)) },
    );

    this.sink = new CanvasSink(videoTrack, {
      poolSize: 5,
      alpha,
      ...options,
    });
    postDecoderDiagnostic(
      diagnostics,
      "worker:video:sink-created",
      initStartedAtMs,
      { width: options.width, height: options.height, fit: options.fit },
    );
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

  async init(
    url: string,
    _options?: RenderOptions,
    file?: File,
    diagnostics?: DecoderRequestDiagnostics,
  ): Promise<void> {
    const initStartedAtMs = performance.now();
    this.dispose();
    postDecoderDiagnostic(diagnostics, "worker:image:init:start", initStartedAtMs, {
      hasFile: !!file,
      fileSizeMB: file ? Number((file.size / (1024 * 1024)).toFixed(2)) : null,
      sourceScheme: file ? "blob-file" : getUrlScheme(url),
    });
    try {
      const blob = file ?? await (await fetch(url)).blob();
      postDecoderDiagnostic(
        diagnostics,
        "worker:image:blob-ready",
        initStartedAtMs,
        { blobSizeMB: Number((blob.size / (1024 * 1024)).toFixed(2)) },
      );
      this.sourceBitmap = await createImageBitmap(blob);
      postDecoderDiagnostic(
        diagnostics,
        "worker:image:bitmap-created",
        initStartedAtMs,
        {
          width: this.sourceBitmap.width,
          height: this.sourceBitmap.height,
        },
      );
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
let renderRequestQueueState = createRenderRequestQueueState<RenderRequest>();

// --- Helper: Message Processing ---
const maybeReplyToDroppedStrictRequest = (
  request: RenderRequest | null,
  reason: "clip-disposed" | "replaced-by-newer-request",
) => {
  if (!request || request.strict !== true || !request.requestId) {
    return;
  }

  const droppedAtMs = performance.now();
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "frame",
    bitmap: null,
    time: request.time,
    clipId: request.clipId,
    transformTime: request.transformTime,
    requestId: request.requestId,
  });
  postDecoderDiagnostic(
    request.diagnostics,
    "worker:render:displaced",
    droppedAtMs,
    { reason, requestId: request.requestId },
  );
  postDecoderDiagnostic(
    request.diagnostics,
    "worker:render:posted-frame",
    droppedAtMs,
    { hasBitmap: false, displaced: true, reason },
  );
};

const cleanupRenderer = (clipId: string) => {
  const renderer = renderers.get(clipId);
  if (renderer) {
    renderer.dispose();
    renderers.delete(clipId);
  }
  rendererKinds.delete(clipId);
  initPromises.delete(clipId);
  const { clearedRequest, queueState } = clearPendingRenderRequest(
    renderRequestQueueState,
    clipId,
  );
  renderRequestQueueState = queueState;
  maybeReplyToDroppedStrictRequest(clearedRequest, "clip-disposed");
};

const processRender = async (request: RenderRequest) => {
  const { time, clipId, transformTime, strict, requestId, diagnostics } =
    request;
  const renderStartedAtMs = performance.now();
  postDecoderDiagnostic(diagnostics, "worker:render:start", renderStartedAtMs, {
    time,
    strict: strict === true,
    requestId,
  });
  const renderer = renderers.get(clipId);
  const ctx = self as DedicatedWorkerGlobalScope;

  if (!renderer) {
    // Safety: If no renderer exists, send null so main thread doesn't hang.
    // The reason tag lets consumers distinguish "no frame available" from
    // "the source was never prepared" — the latter silently blanks exports.
    ctx.postMessage({
      type: "frame",
      bitmap: null,
      time,
      clipId,
      transformTime,
      requestId,
      reason: "missing-renderer",
    });
    postDecoderDiagnostic(
      diagnostics,
      "worker:render:missing-renderer",
      renderStartedAtMs,
    );
    return;
  }

  try {
    const bitmap = await renderer.render(time);
    postDecoderDiagnostic(diagnostics, "worker:render:done", renderStartedAtMs, {
      hasBitmap: !!bitmap,
    });

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
      postDecoderDiagnostic(
        diagnostics,
        "worker:render:posted-frame",
        renderStartedAtMs,
        { hasBitmap: true },
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
      postDecoderDiagnostic(
        diagnostics,
        "worker:render:posted-frame",
        renderStartedAtMs,
        { hasBitmap: false },
      );
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
      postDecoderDiagnostic(
        diagnostics,
        "worker:render:disposed",
        renderStartedAtMs,
      );
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
    postDecoderDiagnostic(diagnostics, "worker:render:error", renderStartedAtMs, {
      error: msg,
    });
  }
};

const loop = async (initialRequest: RenderRequest) => {
  let nextRequest: RenderRequest | null = initialRequest;

  while (nextRequest !== null) {
    try {
      await processRender(nextRequest);
    } catch (err) {
      // processRender replies on its own error paths; this guard only keeps an
      // unexpected throw from leaving the clip marked active forever, which
      // would silently block every future render for it (ping-based recovery
      // cannot detect it because the worker loop stays responsive).
      console.error(`Render loop error [${nextRequest.clipId}]:`, err);
    }
    const result: CompleteRenderRequestResult<RenderRequest> =
      completeRenderRequest(renderRequestQueueState, nextRequest.clipId);
    renderRequestQueueState = result.queueState;
    nextRequest = result.nextRequest;
  }
};


// --- Message Handler ---
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type } = e.data;

  try {
    switch (type) {
      case "ping": {
        const { pingId } = e.data as Extract<WorkerMessage, { type: "ping" }>;
        postWorkerHealth("pong", { pingId, rendererCount: renderers.size });
        break;
      }

      case "prepare": {
        const { url, clipId, kind, width, height, fit, file, diagnostics } =
          e.data as Extract<WorkerMessage, { type: "prepare" }>;
        const prepareReceivedAtMs = performance.now();
        postDecoderDiagnostic(
          diagnostics,
          "worker:prepare:received",
          prepareReceivedAtMs,
          {
            kind,
            hasFile: !!file,
            fileSizeMB: file
              ? Number((file.size / (1024 * 1024)).toFixed(2))
              : null,
            sourceScheme: file ? "blob-file" : getUrlScheme(url),
          },
        );

        if (renderers.has(clipId)) {
          const initPromise = initPromises.get(clipId);
          if (initPromise) {
            postDecoderDiagnostic(
              diagnostics,
              "worker:prepare:await-existing:start",
              prepareReceivedAtMs,
            );
            await initPromise;
            postDecoderDiagnostic(
              diagnostics,
              "worker:prepare:await-existing:done",
              prepareReceivedAtMs,
            );
          }
          self.postMessage({
            type: "ready",
            clipId,
            kind: rendererKinds.get(clipId) ?? kind,
          });
          postDecoderDiagnostic(
            diagnostics,
            "worker:prepare:posted-ready-existing",
            prepareReceivedAtMs,
          );
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
        const promise = renderer.init(
          url,
          { width, height, fit },
          file,
          diagnostics,
        );
        initPromises.set(clipId, promise);

        try {
          await promise;
          self.postMessage({ type: "ready", clipId, kind });
          postDecoderDiagnostic(
            diagnostics,
            "worker:prepare:posted-ready",
            prepareReceivedAtMs,
          );
        } catch (err) {
          postDecoderDiagnostic(
            diagnostics,
            "worker:prepare:error",
            prepareReceivedAtMs,
            { error: String(err) },
          );
          cleanupRenderer(clipId);
          throw err;
        }
        break;
      }

      case "render": {
        const { clipId, time, transformTime, strict, requestId, diagnostics } =
          e.data as Extract<WorkerMessage, { type: "render" }>;
        const renderReceivedAtMs = performance.now();
        postDecoderDiagnostic(
          diagnostics,
          "worker:render:received",
          renderReceivedAtMs,
          { time, strict: strict === true, requestId },
        );

        const initPromise = initPromises.get(clipId);
        if (initPromise) {
          postDecoderDiagnostic(
            diagnostics,
            "worker:render:await-prepare:start",
            renderReceivedAtMs,
          );
          await initPromise;
          postDecoderDiagnostic(
            diagnostics,
            "worker:render:await-prepare:done",
            renderReceivedAtMs,
          );
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
            reason: "missing-renderer",
          });
          postDecoderDiagnostic(
            diagnostics,
            "worker:render:missing-renderer",
            renderReceivedAtMs,
          );
          return;
        }

        const renderRequest = {
          time,
          clipId,
          transformTime,
          strict,
          requestId,
          diagnostics,
        };
        const { displacedRequest, queueState, shouldStart } =
          enqueueRenderRequest(renderRequestQueueState, renderRequest);
        renderRequestQueueState = queueState;
        maybeReplyToDroppedStrictRequest(
          displacedRequest,
          "replaced-by-newer-request",
        );
        if (!shouldStart) {
          postDecoderDiagnostic(
            diagnostics,
            "worker:render:queued-behind-active",
            renderReceivedAtMs,
          );
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
