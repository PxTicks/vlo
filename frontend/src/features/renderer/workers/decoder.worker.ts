import { Input, UrlSource, CanvasSink, ALL_FORMATS, BlobSource } from "mediabunny";
import type { WrappedCanvas } from "mediabunny";
import { isFrameTimestampReady } from "../utils/frameTiming";

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
  | { type: "render"; time: number; clipId: string; transformTime?: number; strict?: boolean }
  | { type: "dispose"; clipId: string };

type TransformTime = number;

// --- Video Renderer Strategy ---
class VideoRenderer implements Renderer {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private videoIterator?: AsyncGenerator<WrappedCanvas, void, unknown>;
  private nextVideoFrame?: WrappedCanvas | null;

  async init(
    url: string,
    options: RenderOptions,
    file?: File
  ): Promise<void> {
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

    // 1. Check if we can reuse the iterator (Sequential Playback)
    const needsReset =
      !this.videoIterator ||
      !this.nextVideoFrame ||
      this.nextVideoFrame.timestamp > time + 0.1 || // Seek backwards
      this.nextVideoFrame.timestamp < time - 1.0; // Seek forwards (large gap)

    if (needsReset) {
      if (this.videoIterator) {
        void this.videoIterator.return();
      }
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
        frame = this.nextVideoFrame!;

        const nextResult = await this.videoIterator!.next();
        this.nextVideoFrame = nextResult.value ?? null;
      } else {
        frame = null;
      }
    }

    // Catch up logic
    while (
      this.nextVideoFrame &&
      isFrameTimestampReady(this.nextVideoFrame.timestamp, time)
    ) {
      frame = this.nextVideoFrame;
      const next = await this.videoIterator!.next();
      this.nextVideoFrame = next.value ?? null;
    }

    if (frame && frame.canvas) {
      if (frame.canvas instanceof OffscreenCanvas) {
        bitmap = frame.canvas.transferToImageBitmap();
      } else {
        bitmap = await createImageBitmap(frame.canvas);
      }
    }

    return bitmap;
  }

  dispose(): void {
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
let pendingRender: { time: number; clipId: string; transformTime?: TransformTime; strict?: boolean } | null = null;

async function convertMaskBitmapToAlpha(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Failed to create 2D context for mask conversion");
  }

  context.clearRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let hasUsefulAlpha = false;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 255) {
      hasUsefulAlpha = true;
      break;
    }
  }

  for (let index = 0; index < data.length; index += 4) {
    const source = hasUsefulAlpha ? data[index + 3] : data[index];
    const alpha = source >= 128 ? 255 : 0;
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = alpha;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}

// --- Helper: Message Processing ---
const processRender = async (time: number, clipId: string, transformTime?: TransformTime, strict?: boolean) => {
  const renderer = renderers.get(clipId);
  const rendererKind = rendererKinds.get(clipId) ?? "video";
  const ctx = self as DedicatedWorkerGlobalScope;

  if (!renderer) {
      // Safety: If no renderer exists, send null so main thread doesn't hang
      ctx.postMessage({
        type: "frame",
        bitmap: null,
        time,
        clipId,
        transformTime
      });
      return;
  }

  try {
    let bitmap = await renderer.render(time);
    if (bitmap && rendererKind === "mask_video") {
      bitmap = await convertMaskBitmapToAlpha(bitmap);
    }
    
    // FIX: Always reply, even if bitmap is null
    if (bitmap) {
       ctx.postMessage(
          {
            type: "frame",
            bitmap,
            time,
            clipId,
            transformTime,
          },
          [bitmap]
        );
    } else if (strict) {
        // IMPORTANT: Send null frame to unblock ExportRenderer (only if strict mode)
        ctx.postMessage({
            type: "frame",
            bitmap: null,
            time,
            clipId,
            transformTime,
        });
    }
  } catch (err) {
      const msg = String(err);
      if (msg.includes("InputDisposedError") || msg.includes("Input has been disposed")) {
          // If disposed, we should still probably unlock the thread if it was waiting
           ctx.postMessage({
            type: "frame",
            bitmap: null,
            time,
            clipId,
            transformTime,
            error: "disposed"
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
        error: msg
    });
  }
};

const loop = async (initialTime: number, clipId: string, initialTransformTime?: TransformTime, initialStrict?: boolean) => {
    isRendering = true;
    let nextRequest: { time: number; clipId: string; transformTime?: TransformTime; strict?: boolean } | null = { time: initialTime, clipId, transformTime: initialTransformTime, strict: initialStrict };

    while (nextRequest !== null) {
        await processRender(nextRequest.time, nextRequest.clipId, nextRequest.transformTime, nextRequest.strict);

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
        const { url, clipId, kind, width, height, fit, file } = e.data as Extract<WorkerMessage, { type: "prepare" }>;
        
        if (renderers.has(clipId)) return;

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
        
        await promise;
        self.postMessage({ type: "ready", clipId, kind });
        break;
      }

      case "render": {
        const { clipId, time, transformTime, strict } = e.data as Extract<WorkerMessage, { type: "render" }>;
        
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
                transformTime
            });
            return;
        }

        if (isRendering) {
           pendingRender = { time, clipId, transformTime, strict };
        } else {
           loop(time, clipId, transformTime, strict);
        }
        break;
      }

      case "dispose": {
        const { clipId } = e.data as Extract<WorkerMessage, { type: "dispose" }>;
        const renderer = renderers.get(clipId);
        if (renderer) {
          renderer.dispose();
          renderers.delete(clipId);
        }
        rendererKinds.delete(clipId);
        initPromises.delete(clipId);
        if (pendingRender && pendingRender.clipId === clipId) {
            pendingRender = null;
        }
        break;
      }
    }
  } catch (err) {
    console.error("Worker Error:", err);
    self.postMessage({ type: "error", message: String(err) });
  }
};
