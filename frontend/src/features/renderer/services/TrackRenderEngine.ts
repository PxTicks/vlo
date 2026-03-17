import { Container, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  TimelineClip,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import DecoderWorker from "../workers/decoder.worker?worker";
import {
  calculatePlayerFrameTime,
  snapFrameTimeSeconds,
} from "../utils/renderTime";
import { findActiveClipAtTicks } from "../utils/clipLookup";
import { applyClipTransforms } from "../../transformations";
import { SpriteClipMaskController } from "../../masks/runtime/SpriteClipMaskController";
import { TICKS_PER_SECOND } from "../../timeline";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

interface LiveRenderRequest {
  clip: TimelineClip;
  maskClips: MaskTimelineClip[];
  assetsById: Map<string, Asset>;
  logicalDimensions: { width: number; height: number };
  localTimeSeconds: number;
  rawTimeTicks: number;
  enqueuedAtMs: number;
}

interface PendingLiveFrame {
  resolve: (payload: {
    bitmap: ImageBitmap | null;
    clipId: string;
    transformTime: number | undefined;
  }) => void;
  reject: (error: Error) => void;
}

/**
 * Encapsulates the rendering logic for a single track.
 * Manages the WebWorker, PIXI.Sprite, and frame synchronization.
 *
 * Used by both:
 * 1. useTrackRenderer (Live Playback)
 * 2. ExportRenderer (Offline Rendering)
 */
export class TrackRenderEngine {
  private static readonly MAX_LIVE_RENDER_QUEUE = 4;
  private static readonly MAX_LIVE_REQUEST_AGE_MS = 180;

  public readonly sprite: Sprite;
  public readonly container: Container;
  private worker: Worker;

  // State
  private preparedClips = new Map<string, string>(); // clipId -> assetId
  private preparedClipTouchedAtMs = new Map<string, number>(); // clipId -> perf.now()
  private currentTextureClipId: string | null = null;
  private lastRenderRequest: {
    time: number;
    clipId: string;
    frameIndex?: number;
  } | null = null;
  private lastUpdateTime: number | null = null;
  private lastUpdateDirection: -1 | 0 | 1 = 0;
  private scrubActiveUntilMs = 0;

  // Export Mode Resolution
  private pendingResolve: ((bitmap: ImageBitmap | null) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private pendingAbortCleanup: (() => void) | null = null;
  private pendingLiveFrame: PendingLiveFrame | null = null;

  // Live synchronized pipeline
  private liveRenderQueue: LiveRenderRequest[] = [];
  private livePipelineBusy = false;

  // Deferred texture cleanup to avoid null-source races during hot swaps
  private readonly retiredTextures = new Set<Texture>();
  private retiredTextureFlushHandle:
    | number
    | ReturnType<typeof setTimeout>
    | null = null;
  private retiredTextureFlushKind: "raf" | "timeout" | null = null;
  private disposed = false;

  // Live Mode Callback (to sync transforms immediately)
  private onFrameReady?: (clipId: string, transformTime: number) => void;
  private maskController: SpriteClipMaskController;

  /**
   * @param zIndex The z-index of the sprite
   * @param onFrameReady Optional callback when a frame is ready (used for Live mode transforms)
   * @param renderer Optional PixiJS renderer for compositing mask textures
   */
  constructor(
    zIndex: number,
    onFrameReady?: (clipId: string, transformTime: number) => void,
    renderer?: Renderer | null,
  ) {
    this.worker = new DecoderWorker();
    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    this.onFrameReady = onFrameReady;

    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);

    // encapsulated container
    this.container = new Container();
    this.maskController = new SpriteClipMaskController(
      this.sprite,
      renderer,
      this.container,
    );
    this.container.addChild(this.sprite);
    this.container.zIndex = zIndex;
  }

  public addTo(parent: Container) {
    parent.addChild(this.container);
  }

  public setZIndex(zIndex: number) {
    this.container.zIndex = zIndex;
  }

  /**
   * Main Render Loop
   * @param currentTime Global time in ticks
   * @param trackClips List of clips for this track (non-mask clips only)
   * @param maskClipsByParent Map from parent clip id to its mask clips
   * @param assets List of available assets
   * @param logicalDimensions Project resolution
   */
  public update(
    currentTime: number,
    trackClips: TimelineClip[],
    maskClipsByParent: Map<string, MaskTimelineClip[]>,
    assets: Asset[],
    logicalDimensions: { width: number; height: number },
    options: { shouldRender?: boolean; fps?: number } = {},
  ): Promise<void> | void {
    const { shouldRender = true, fps = 30 } = options;
    const nowMs = performance.now();
    const isLikelyScrubbing = this.detectScrubbing(currentTime, fps, nowMs);
    const assetById = this.syncPreparedClips(
      currentTime,
      trackClips,
      assets,
      nowMs,
      isLikelyScrubbing,
    );

    // 3. Identify Active Clip
    const activeClip = findActiveClipAtTicks(trackClips, currentTime);

    // 4. Handle Blank Space
    if (!activeClip) {
      this.invalidateLivePipeline();
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      // For Export Mode: If we are awaiting a frame but none exists, resolve immediately
      if (this.pendingResolve) {
        const resolvePending = this.pendingResolve;
        this.clearPendingFrameState();
        resolvePending(null);
      }
      return Promise.resolve();
    }

    // 5. Calculate Time
    const localTimeSeconds = calculatePlayerFrameTime(activeClip, currentTime);
    const rawTimeSeconds = currentTime - activeClip.start;

    if (typeof localTimeSeconds !== "number" || isNaN(localTimeSeconds)) {
      if (this.pendingResolve) {
        const resolvePending = this.pendingResolve;
        this.clearPendingFrameState();
        resolvePending(null);
      }
      return Promise.resolve();
    }

    // Sync masks from first-class mask clips
    const maskClips = maskClipsByParent.get(activeClip.id) ?? [];

    // 6. Send Render Request
    // Optimization: Don't request same frame twice (Live Mode only)
    // For Export, we usually force request or trust the caller loop
    const renderTimeSeconds = snapFrameTimeSeconds(localTimeSeconds, fps);
    const currentFrameIndex = this.getFrameIndex(renderTimeSeconds, fps);

    const shouldSend =
      !this.lastRenderRequest ||
      this.lastRenderRequest.frameIndex !== currentFrameIndex ||
      this.lastRenderRequest.clipId !== activeClip.id ||
      this.pendingResolve !== null; // Always send if strictly awaiting (Export)

    if (shouldSend && shouldRender) {
      this.lastRenderRequest = {
        time: renderTimeSeconds,
        clipId: activeClip.id,
        frameIndex: currentFrameIndex,
      };

      // Join content frame + asset-backed masks at the same timeline time.
      // Requests are committed in enqueue order.
      this.enqueueLiveRenderRequest({
        clip: activeClip,
        maskClips,
        assetsById: assetById,
        logicalDimensions,
        localTimeSeconds: renderTimeSeconds,
        rawTimeTicks: rawTimeSeconds,
        enqueuedAtMs: nowMs,
      });
    } else if (!shouldSend || !shouldRender) {
      // Keep transforms/filters responsive without requesting a new SAM2 frame.
      void this.maskController
        .syncMaskClips(
          maskClips,
          activeClip,
          logicalDimensions,
          rawTimeSeconds,
          assetById,
          { fps, skipSam2FrameRender: true },
        )
        .catch((error) => {
          console.warn("Failed to sync live masks", error);
        });
    }

    // 7. Apply Immediate Transforms (even if texture hasn't updated yet)
    // This ensures moving/scaling feels responsive even if the frame decoding lags
    if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
      applyClipTransforms(
        this.sprite,
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
      );
      this.maskController.syncMaskSpriteTransform();
    }

    // 8. Return Promise for Export Sync
    if (this.pendingResolve) {
      // Return a promise that waits for the worker to invoke pendingResolve
    }

    return Promise.resolve();
  }

  public async renderSynchronizedPlaybackFrame(
    currentTime: number,
    trackClips: TimelineClip[],
    maskClipsByParent: Map<string, MaskTimelineClip[]>,
    assets: Asset[],
    logicalDimensions: { width: number; height: number },
    options: { fps?: number } = {},
  ): Promise<void> {
    const fps = options.fps ?? 30;
    const nowMs = performance.now();
    const assetById = this.syncPreparedClips(
      currentTime,
      trackClips,
      assets,
      nowMs,
      false,
    );

    this.invalidateLivePipeline();

    const activeClip = findActiveClipAtTicks(trackClips, currentTime);
    if (!activeClip) {
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return;
    }

    const localTimeSeconds = calculatePlayerFrameTime(activeClip, currentTime);
    const rawTimeSeconds = currentTime - activeClip.start;

    if (typeof localTimeSeconds !== "number" || isNaN(localTimeSeconds)) {
      return;
    }

    const maskClips = maskClipsByParent.get(activeClip.id) ?? [];
    const renderTimeSeconds = snapFrameTimeSeconds(localTimeSeconds, fps);
    const currentFrameIndex = this.getFrameIndex(renderTimeSeconds, fps);
    const shouldSend =
      !this.lastRenderRequest ||
      this.lastRenderRequest.frameIndex !== currentFrameIndex ||
      this.lastRenderRequest.clipId !== activeClip.id;

    if (shouldSend) {
      this.lastRenderRequest = {
        time: renderTimeSeconds,
        clipId: activeClip.id,
        frameIndex: currentFrameIndex,
      };

      try {
        const [frame] = await Promise.all([
          this.requestStrictLiveFrame(
            renderTimeSeconds,
            activeClip.id,
            rawTimeSeconds,
          ),
          this.maskController.syncMaskClips(
            maskClips,
            activeClip,
            logicalDimensions,
            rawTimeSeconds,
            assetById,
            { fps, waitForSam2: true },
          ),
        ]);

        if (frame.bitmap) {
          const texture = Texture.from(frame.bitmap);
          this.applyTexture(texture, activeClip.id);
        } else if (this.currentTextureClipId !== activeClip.id) {
          this.sprite.visible = false;
          this.currentTextureClipId = null;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.warn("Failed to prepare synchronized playback frame", error);
        return;
      }
    } else {
      try {
        await this.maskController.syncMaskClips(
          maskClips,
          activeClip,
          logicalDimensions,
          rawTimeSeconds,
          assetById,
          { fps, skipSam2FrameRender: true },
        );
      } catch (error) {
        console.warn("Failed to sync synchronized playback masks", error);
      }
    }

    if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
      applyClipTransforms(
        this.sprite,
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
      );
      this.maskController.syncMaskSpriteTransform();
    }
  }

  /**
   * Explicitly wait for the next frame. Used by ExportRenderer.
   */
  public async renderFrame(
    currentTime: number,
    activeClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    maskClips: MaskTimelineClip[] = [],
    assetsById: Map<string, Asset> = new Map<string, Asset>(),
    options: { fps?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.invalidateLivePipeline();

    const rawTime = currentTime - activeClip.start;
    await this.maskController.syncMaskClips(
      maskClips,
      activeClip,
      logicalDimensions,
      rawTime,
      assetsById,
      { fps: options.fps, waitForSam2: true },
    );

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createRenderAbortError());
        return;
      }

      if (this.pendingReject) {
        this.rejectPendingFrame(new Error("Concurrent renderFrame() is not supported"));
      }

      let isSettled = false;
      const settle = <T extends unknown[]>(handler: (...args: T) => void) => {
        return (...args: T) => {
          if (isSettled) return;
          isSettled = true;
          this.clearPendingFrameState();
          handler(...args);
        };
      };

      const resolveFrame = settle((bitmap: ImageBitmap | null) => {
        this.updateTexture(bitmap, activeClip, logicalDimensions, rawTime);
        resolve();
      });
      const rejectFrame = settle((error: Error) => {
        reject(error);
      });

      if (options.signal) {
        const onAbort = () => rejectFrame(createRenderAbortError());
        options.signal.addEventListener("abort", onAbort, { once: true });
        this.pendingAbortCleanup = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pendingResolve = (bitmap) => {
        resolveFrame(bitmap);
      };
      this.pendingReject = (error) => rejectFrame(error);

      const localTime = calculatePlayerFrameTime(activeClip, currentTime);
      const renderTime =
        typeof options.fps === "number" && options.fps > 0
          ? snapFrameTimeSeconds(localTime, options.fps)
          : localTime;

      this.worker.postMessage({
        type: "render",
        time: renderTime,
        clipId: activeClip.id,
        transformTime: rawTime,
        strict: true, // Export needs a response even if null
      });
    });
  }

  public cancelPendingFrame(error: Error = createRenderAbortError()) {
    this.rejectPendingFrame(error);
  }

  private handleWorkerMessage(e: MessageEvent) {
    const { type, bitmap, clipId, transformTime, error, message } = e.data;

    if (type === "frame") {
      if (this.pendingResolve) {
        // Export Mode: Resolves the promise
        this.pendingResolve(bitmap);
      } else if (this.pendingLiveFrame) {
        const pendingLiveFrame = this.pendingLiveFrame;
        this.pendingLiveFrame = null;
        if (error) {
          pendingLiveFrame.reject(new Error(String(error)));
          return;
        }
        pendingLiveFrame.resolve({
          bitmap,
          clipId,
          transformTime:
            typeof transformTime === "number" ? transformTime : undefined,
        });
      } else {
        // Ignore orphaned frames that no longer belong to an active request.
        if (bitmap && typeof bitmap.close === "function") {
          bitmap.close();
        }
      }
      return;
    }

    if (type === "error") {
      const workerError = new Error(
        typeof message === "string" ? message : "Decoder worker error",
      );
      this.rejectPendingFrame(workerError);
      this.rejectPendingLiveFrame(workerError);
      return;
    }
  }

  private enqueueLiveRenderRequest(request: LiveRenderRequest) {
    this.liveRenderQueue.push(request);
    this.pruneLiveRenderQueue(request.enqueuedAtMs);
    void this.runLiveRenderPipeline();
  }

  private syncPreparedClips(
    currentTime: number,
    trackClips: TimelineClip[],
    assets: Asset[],
    nowMs: number,
    isLikelyScrubbing: boolean,
  ): Map<string, Asset> {
    // These windows are defined in seconds, then converted to ticks.
    const LOOKAHEAD_WINDOW_TICKS = 2.0 * TICKS_PER_SECOND;
    const CLEANUP_DELAY_TICKS =
      (isLikelyScrubbing ? 6.0 : 1.0) * TICKS_PER_SECOND;
    const MIN_PREPARED_LIFETIME_MS = isLikelyScrubbing ? 1200 : 0;
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const clipById = new Map<string, TimelineClip>();
    const relevantClipIds = new Set<string>();

    trackClips.forEach((clip) => {
      clipById.set(clip.id, clip);
      const clipEnd = clip.start + clip.timelineDuration;
      const isRelevant =
        clip.start <= currentTime + LOOKAHEAD_WINDOW_TICKS &&
        clipEnd > currentTime - CLEANUP_DELAY_TICKS;

      if (!isRelevant) {
        return;
      }

      relevantClipIds.add(clip.id);
      this.preparedClipTouchedAtMs.set(clip.id, nowMs);
      const storedAssetId = this.preparedClips.get(clip.id);
      if (storedAssetId === clip.assetId) {
        return;
      }

      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
      if (!asset || !clip.assetId) {
        return;
      }

      this.worker.postMessage({
        type: "prepare",
        url: asset.src,
        clipId: clip.id,
        kind: clip.type,
        file: asset.file,
      });
      this.preparedClips.set(clip.id, clip.assetId);
    });

    for (const [clipId] of this.preparedClips) {
      const clip = clipById.get(clipId);
      const isStillRelevant =
        !!clip &&
        relevantClipIds.has(clipId) &&
        clip.start <= currentTime + LOOKAHEAD_WINDOW_TICKS &&
        clip.start + clip.timelineDuration > currentTime - CLEANUP_DELAY_TICKS;

      if (isStillRelevant) {
        continue;
      }

      const touchedAtMs = this.preparedClipTouchedAtMs.get(clipId) ?? 0;
      const ageMs = nowMs - touchedAtMs;
      if (ageMs < MIN_PREPARED_LIFETIME_MS) {
        continue;
      }

      this.worker.postMessage({ type: "dispose", clipId });
      this.preparedClips.delete(clipId);
      this.preparedClipTouchedAtMs.delete(clipId);
    }

    return assetById;
  }

  private getFrameIndex(localTimeSeconds: number, fps: number): number {
    const safeFps = Math.max(1, fps);
    const frameEpsilonSeconds = 1 / (safeFps * 1_000_000);
    return Math.floor((localTimeSeconds + frameEpsilonSeconds) * safeFps);
  }

  private async runLiveRenderPipeline(): Promise<void> {
    if (this.livePipelineBusy || this.disposed) return;
    this.livePipelineBusy = true;

    try {
      while (this.liveRenderQueue.length > 0 && !this.disposed) {
        this.pruneLiveRenderQueue(performance.now());
        const request = this.liveRenderQueue.shift();
        if (!request) continue;

        try {
          const [frame] = await Promise.all([
            this.requestStrictLiveFrame(
              request.localTimeSeconds,
              request.clip.id,
              request.rawTimeTicks,
            ),
            this.maskController.syncMaskClips(
              request.maskClips,
              request.clip,
              request.logicalDimensions,
              request.rawTimeTicks,
              request.assetsById,
              { waitForSam2: true },
            ),
          ]);

          if (frame.bitmap) {
            const texture = Texture.from(frame.bitmap);
            this.applyTexture(texture, request.clip.id);
          }

          if (this.sprite.visible && this.currentTextureClipId === request.clip.id) {
            applyClipTransforms(
              this.sprite,
              request.clip,
              request.logicalDimensions,
              request.rawTimeTicks,
            );
            this.maskController.syncMaskSpriteTransform();
          }

          if (this.onFrameReady) {
            this.onFrameReady(request.clip.id, request.rawTimeTicks);
          }
        } catch (error) {
          console.warn("Failed to render synchronized live frame", error);
        }
      }
    } finally {
      this.livePipelineBusy = false;
      if (this.liveRenderQueue.length > 0 && !this.disposed) {
        void this.runLiveRenderPipeline();
      }
    }
  }

  private requestStrictLiveFrame(
    localTimeSeconds: number,
    clipId: string,
    transformTime: number,
  ): Promise<{
    bitmap: ImageBitmap | null;
    clipId: string;
    transformTime: number | undefined;
  }> {
    this.rejectPendingLiveFrame(new Error("Superseded live frame request"));

    return new Promise((resolve, reject) => {
      this.pendingLiveFrame = { resolve, reject };
      this.worker.postMessage({
        type: "render",
        time: localTimeSeconds,
        clipId,
        transformTime,
        strict: true,
      });
    });
  }

  private invalidateLivePipeline() {
    this.liveRenderQueue.length = 0;
    this.rejectPendingLiveFrame(createRenderAbortError());
  }

  private pruneLiveRenderQueue(nowMs: number) {
    while (
      this.liveRenderQueue.length > 0 &&
      nowMs - this.liveRenderQueue[0].enqueuedAtMs >
        TrackRenderEngine.MAX_LIVE_REQUEST_AGE_MS
    ) {
      this.liveRenderQueue.shift();
    }

    if (this.liveRenderQueue.length <= TrackRenderEngine.MAX_LIVE_RENDER_QUEUE) {
      return;
    }

    const overflow =
      this.liveRenderQueue.length - TrackRenderEngine.MAX_LIVE_RENDER_QUEUE;
    this.liveRenderQueue.splice(0, overflow);
  }

  private updateTexture(
    bitmap: ImageBitmap | null,
    clip: TimelineClip,
    dimensions: { width: number; height: number },
    rawTime: number,
  ) {
    if (bitmap) {
      const texture = Texture.from(bitmap);
      this.applyTexture(texture, clip.id);
      applyClipTransforms(this.sprite, clip, dimensions, rawTime);
      this.maskController.syncMaskSpriteTransform();
    }
  }

  private applyTexture(texture: Texture, clipId: string) {
    const previousTexture = this.sprite.texture;
    this.sprite.texture = texture;
    this.retireTexture(previousTexture);
    this.sprite.visible = true;
    this.currentTextureClipId = clipId;
  }

  /**
   * Force an immediate transform update.
   * Useful for responsiveness when the viewport resizes while paused.
   */
  public forceUpdateTransforms(
    activeClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    currentTime: number,
    maskClips: MaskTimelineClip[] = [],
    assetsById: Map<string, Asset> = new Map<string, Asset>(),
  ) {
    if (!this.sprite.visible) return;
    const rawTimeSeconds = currentTime - activeClip.start;
    applyClipTransforms(
      this.sprite,
      activeClip,
      logicalDimensions,
      rawTimeSeconds,
    );
    this.maskController.syncMaskSpriteTransform();
    void this.maskController
      .syncMaskClips(
        maskClips,
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
        assetsById,
        { skipSam2FrameRender: true },
      )
      .catch((error) => {
        console.warn("Failed to force-update mask clips", error);
      });
  }

  public syncMaskSpriteTransform() {
    this.maskController.syncMaskSpriteTransform();
  }

  public dispose() {
    if (this.disposed) return;
    this.disposed = true;

    this.rejectPendingFrame(createRenderAbortError());
    this.rejectPendingLiveFrame(createRenderAbortError());
    this.invalidateLivePipeline();

    this.cancelRetiredTextureFlush();
    const currentTexture = this.sprite.texture;
    this.sprite.texture = Texture.EMPTY;
    this.destroyTexture(currentTexture);
    this.flushRetiredTextures();

    this.maskController.dispose();
    this.worker.terminate();
    if (this.container) {
      if (this.container.parent) {
        this.container.removeFromParent();
      }
      if (!this.container.destroyed) {
        this.container.destroy({ children: true, texture: true });
      }
    }
    this.preparedClips.clear();
    this.preparedClipTouchedAtMs.clear();
    this.lastUpdateTime = null;
    this.lastUpdateDirection = 0;
    this.scrubActiveUntilMs = 0;
  }

  /**
   * Detects scrub/seek-like navigation patterns from timeline deltas.
   * During these bursts we keep prepared decoders alive a bit longer to avoid churn.
   */
  private detectScrubbing(
    currentTime: number,
    fps: number,
    nowMs: number,
  ): boolean {
    const previousTime = this.lastUpdateTime;
    this.lastUpdateTime = currentTime;

    if (previousTime === null) return false;

    const deltaTicks = currentTime - previousTime;
    const absDeltaTicks = Math.abs(deltaTicks);
    const direction: -1 | 0 | 1 =
      deltaTicks === 0 ? 0 : deltaTicks > 0 ? 1 : -1;
    const frameTicks = TICKS_PER_SECOND / Math.max(1, fps);
    const largeJump = absDeltaTicks > frameTicks * 1.5;
    const directionFlip =
      direction !== 0 &&
      this.lastUpdateDirection !== 0 &&
      direction !== this.lastUpdateDirection;

    if (largeJump || directionFlip) {
      this.scrubActiveUntilMs = nowMs + 220;
    }
    if (direction !== 0) {
      this.lastUpdateDirection = direction;
    }

    return nowMs < this.scrubActiveUntilMs;
  }

  private clearPendingFrameState() {
    if (this.pendingAbortCleanup) {
      this.pendingAbortCleanup();
      this.pendingAbortCleanup = null;
    }
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  private rejectPendingFrame(error: Error) {
    if (!this.pendingReject) {
      this.clearPendingFrameState();
      return;
    }
    const rejectPending = this.pendingReject;
    this.clearPendingFrameState();
    rejectPending(error);
  }

  private rejectPendingLiveFrame(error: Error) {
    if (!this.pendingLiveFrame) return;
    const rejectPending = this.pendingLiveFrame.reject;
    this.pendingLiveFrame = null;
    rejectPending(error);
  }

  private retireTexture(texture: Texture | null | undefined): void {
    if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
    if (texture === this.sprite.texture) return;

    this.retiredTextures.add(texture);
    this.scheduleRetiredTextureFlush();
  }

  private scheduleRetiredTextureFlush(): void {
    if (this.retiredTextureFlushHandle !== null || this.retiredTextures.size === 0) {
      return;
    }

    if (typeof requestAnimationFrame === "function") {
      this.retiredTextureFlushKind = "raf";
      this.retiredTextureFlushHandle = requestAnimationFrame(() => {
        this.retiredTextureFlushHandle = null;
        this.retiredTextureFlushKind = null;
        this.flushRetiredTextures();
      });
      return;
    }

    this.retiredTextureFlushKind = "timeout";
    this.retiredTextureFlushHandle = setTimeout(() => {
      this.retiredTextureFlushHandle = null;
      this.retiredTextureFlushKind = null;
      this.flushRetiredTextures();
    }, 0);
  }

  private cancelRetiredTextureFlush(): void {
    if (this.retiredTextureFlushHandle === null) return;

    if (
      this.retiredTextureFlushKind === "raf" &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(this.retiredTextureFlushHandle as number);
    } else {
      clearTimeout(
        this.retiredTextureFlushHandle as ReturnType<typeof setTimeout>,
      );
    }

    this.retiredTextureFlushHandle = null;
    this.retiredTextureFlushKind = null;
  }

  private flushRetiredTextures(): void {
    const activeTexture = this.sprite.texture;
    for (const texture of this.retiredTextures) {
      if (texture === activeTexture) continue;
      this.destroyTexture(texture);
      this.retiredTextures.delete(texture);
    }
  }

  private destroyTexture(texture: Texture | null | undefined): void {
    if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
    texture.destroy(true);
  }
}
