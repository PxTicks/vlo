import { Container, Sprite, Text, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  TimelineClip,
  MaskTimelineClip,
  TextTimelineClip,
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
import { ensureAssetSourceLoaded } from "../../userAssets";
import { hasEmbeddedAssetSource } from "../utils/assetSource";
import {
  RetiredTextureQueue,
  destroyTexture,
} from "../utils/retiredTextureQueue";
import {
  awaitStrictFrame,
  type StrictFramePending,
} from "../utils/strictFrameRequest";
import { resolveTextClipData } from "../../text/utils/textClipData";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

function createLiveFrameTimeoutError(
  timeoutMs: number,
  clipId: string,
): Error {
  const error = new Error(
    `Timed out waiting ${timeoutMs}ms for live frame ${clipId}`,
  );
  error.name = "TimeoutError";
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

interface LiveFramePayload {
  bitmap: ImageBitmap | null;
  clipId: string;
  transformTime: number | undefined;
}

type PendingLiveFrame = StrictFramePending<LiveFramePayload>;

interface InFlightSynchronizedRender {
  activeClip: TimelineClip;
  assets: Asset[];
  currentTime: number;
  fps: number;
  maskClips: MaskTimelineClip[];
  promise: Promise<void>;
}

interface LatestMaskSyncContext {
  maskClips: MaskTimelineClip[];
  clip: TimelineClip;
  logicalDimensions: { width: number; height: number };
  rawTimeTicks: number;
  assetsById: Map<string, Asset>;
  fps?: number;
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
  private static readonly LIVE_FRAME_TIMEOUT_MS = 1500;
  private static readonly SYNCHRONIZED_RECOVERY_ATTEMPTS = 1;

  public readonly sprite: Sprite;
  public readonly container: Container;
  private worker: Worker;
  private readonly renderer: Renderer | null;

  // State
  private preparedClips = new Map<string, string>(); // clipId -> assetId
  private preparedClipTouchedAtMs = new Map<string, number>(); // clipId -> perf.now()
  private currentTextureClipId: string | null = null;
  private currentTextureSourceKind: "asset" | "text" | null = null;
  private currentTextTextureSignature: string | null = null;
  private lastRenderRequest: {
    time: number;
    clipId: string;
    assetId?: string | null;
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
  private pendingAssetHydrations = new Set<string>();
  private livePipelineBusy = false;
  private inFlightSynchronizedRender: InFlightSynchronizedRender | null = null;

  // Deferred texture cleanup to avoid null-source races during hot swaps
  private readonly retiredTextures = new RetiredTextureQueue(
    () => this.sprite.texture,
  );
  private disposed = false;

  // Live Mode Callback (to sync transforms immediately)
  private onFrameReady?: (clipId: string, transformTime: number) => void;
  private maskController: SpriteClipMaskController;
  private latestMaskSyncContext: LatestMaskSyncContext | null = null;
  private pendingAssetMaskFrameResync: Promise<void> | null = null;

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
    this.renderer = renderer ?? null;
    this.worker = this.createWorker();
    this.onFrameReady = onFrameReady;

    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;

    // encapsulated container
    this.container = new Container();
    this.maskController = new SpriteClipMaskController(
      this.sprite,
      renderer,
      this.container,
      () => {
        void this.resyncMasksForLatestAssetMaskFrame();
      },
    );
    if (renderer) {
      // Brush masks render their painted bitmap into a Pixi RenderTexture via
      // this shared renderer. Wiring it once here keeps the registry decoupled
      // from React.
      void import("../../masks/runtime/brushBufferRegistry").then(
        ({ setBrushRenderer }) => setBrushRenderer(renderer),
      );
    }
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

    const asset = activeClip.assetId ? assetById.get(activeClip.assetId) : undefined;
    const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : fps;

    this.latestMaskSyncContext = {
      maskClips,
      clip: activeClip,
      logicalDimensions,
      rawTimeTicks: rawTimeSeconds,
      assetsById: assetById,
      fps: clipFps,
    };

    if (activeClip.type === "text") {
      this.invalidateLivePipeline();

      if (!shouldRender) {
        if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
          this.applyClipTransformsForClip(
            activeClip,
            logicalDimensions,
            rawTimeSeconds,
          );
        }
        return Promise.resolve();
      }

      return this.renderTextClip(
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
        maskClips,
        assetById,
        clipFps,
      ).catch((error) => {
        console.warn("Failed to render text clip", error);
      });
    }

    // 6. Send Render Request
    // Optimization: Don't request same frame twice (Live Mode only)
    // For Export, we usually force request or trust the caller loop
    const renderTimeSeconds = snapFrameTimeSeconds(localTimeSeconds, clipFps);
    const currentFrameIndex = this.getFrameIndex(renderTimeSeconds, clipFps);

    const shouldSend =
      this.shouldRequestFrame(
        activeClip,
        currentFrameIndex,
        renderTimeSeconds,
      ) ||
      this.pendingResolve !== null; // Always send if strictly awaiting (Export)

    if (shouldSend && shouldRender) {
      this.lastRenderRequest = {
        time: renderTimeSeconds,
        clipId: activeClip.id,
        assetId: activeClip.assetId,
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
          { fps: clipFps, skipSam2FrameRender: true },
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
    const { fps = 30 } = options;
    const activeClip = findActiveClipAtTicks(trackClips, currentTime);
    if (!activeClip) {
      this.invalidateLivePipeline();
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
    if (activeClip.type === "text") {
      await this.renderTextClip(
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
        maskClips,
        new Map<string, Asset>(assets.map((asset) => [asset.id, asset] as const)),
        fps,
      );
      return;
    }

    const inFlightSynchronizedRender = this.inFlightSynchronizedRender;
    if (
      inFlightSynchronizedRender &&
      inFlightSynchronizedRender.currentTime === currentTime &&
      inFlightSynchronizedRender.fps === fps &&
      inFlightSynchronizedRender.activeClip === activeClip &&
      this.areSameMaskClipList(
        inFlightSynchronizedRender.maskClips,
        maskClips,
      ) &&
      inFlightSynchronizedRender.assets === assets
    ) {
      return inFlightSynchronizedRender.promise;
    }

    const renderPromise = this.renderSynchronizedPlaybackFrameInternal(
      currentTime,
      trackClips,
      assets,
      logicalDimensions,
      {
        activeClip,
        fps,
        localTimeSeconds,
        maskClips,
        rawTimeSeconds,
      },
    );

    this.inFlightSynchronizedRender = {
      activeClip,
      assets,
      currentTime,
      fps,
      maskClips,
      promise: renderPromise,
    };

    try {
      await renderPromise;
    } finally {
      if (this.inFlightSynchronizedRender?.promise === renderPromise) {
        this.inFlightSynchronizedRender = null;
      }
    }
  }

  private async renderSynchronizedPlaybackFrameInternal(
    currentTime: number,
    trackClips: TimelineClip[],
    assets: Asset[],
    logicalDimensions: { width: number; height: number },
    request: {
      activeClip: TimelineClip;
      fps: number;
      localTimeSeconds: number;
      maskClips: MaskTimelineClip[];
      rawTimeSeconds: number;
    },
  ): Promise<void> {
    const {
      activeClip,
      fps,
      localTimeSeconds,
      maskClips,
      rawTimeSeconds,
    } = request;
    if (activeClip.type === "text") {
      await this.renderTextClip(
        activeClip,
        logicalDimensions,
        rawTimeSeconds,
        maskClips,
        new Map<string, Asset>(assets.map((asset) => [asset.id, asset] as const)),
        fps,
      );
      return;
    }

    for (
      let attempt = 0;
      attempt <= TrackRenderEngine.SYNCHRONIZED_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      const nowMs = performance.now();
      const assetById = this.syncPreparedClips(
        currentTime,
        trackClips,
        assets,
        nowMs,
        false,
      );

      const asset = activeClip.assetId ? assetById.get(activeClip.assetId) : undefined;
      const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : fps;

      const renderTimeSeconds = snapFrameTimeSeconds(localTimeSeconds, clipFps);
      const currentFrameIndex = this.getFrameIndex(renderTimeSeconds, clipFps);

      this.invalidateLivePipeline();

      const shouldSend = this.shouldRequestFrame(
        activeClip,
        currentFrameIndex,
        renderTimeSeconds,
      );

      if (shouldSend) {
        this.lastRenderRequest = {
          time: renderTimeSeconds,
          clipId: activeClip.id,
          assetId: activeClip.assetId,
          frameIndex: currentFrameIndex,
        };

        try {
          const [frame] = await Promise.all([
            this.requestStrictLiveFrame(
              renderTimeSeconds,
              activeClip.id,
              rawTimeSeconds,
              { timeoutMs: TrackRenderEngine.LIVE_FRAME_TIMEOUT_MS },
            ),
            this.maskController.syncMaskClips(
              maskClips,
              activeClip,
              logicalDimensions,
              rawTimeSeconds,
              assetById,
              { fps: clipFps, waitForSam2: true },
            ),
          ]);

          if (frame.bitmap) {
            const texture = Texture.from(frame.bitmap);
            const contentSizeChanged = this.applyTexture(
              texture,
              activeClip.id,
              "asset",
            );
            if (contentSizeChanged) {
              await this.resyncMasksForResolvedTexture(
                maskClips,
                activeClip,
                logicalDimensions,
                rawTimeSeconds,
                assetById,
                clipFps,
              );
            }
          } else if (this.currentTextureClipId !== activeClip.id) {
            this.sprite.visible = false;
            this.currentTextureClipId = null;
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }

          if (
            error instanceof Error &&
            error.name === "TimeoutError" &&
            attempt < TrackRenderEngine.SYNCHRONIZED_RECOVERY_ATTEMPTS
          ) {
            console.warn(
              "Live decoder worker stalled during synchronized playback; recreating worker",
              error,
            );
            this.resetStalledLiveDecoderWorker();
            continue;
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
            { fps: clipFps, skipSam2FrameRender: true },
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

      return;
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

    if (activeClip.type === "text") {
      await this.renderTextClip(
        activeClip,
        logicalDimensions,
        currentTime - activeClip.start,
        maskClips,
        assetsById,
        options.fps,
      );
      return;
    }

    const asset = activeClip.assetId ? assetsById.get(activeClip.assetId) : undefined;
    const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : (options.fps ?? 30);

    const rawTime = currentTime - activeClip.start;
    await this.maskController.syncMaskClips(
      maskClips,
      activeClip,
      logicalDimensions,
      rawTime,
      assetsById,
      { fps: clipFps, waitForSam2: true },
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
        void (async () => {
          try {
            await this.updateTexture(
              bitmap,
              activeClip,
              logicalDimensions,
              rawTime,
              {
                maskClips,
                assetsById,
                fps: clipFps,
              },
            );
            resolve();
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Failed to refresh masks after frame update"),
            );
          }
        })();
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
        typeof clipFps === "number" && clipFps > 0
          ? snapFrameTimeSeconds(localTime, clipFps)
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

  private createWorker(): Worker {
    const worker = new DecoderWorker();
    worker.onmessage = this.handleWorkerMessage.bind(this);
    return worker;
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

      if (storedAssetId !== undefined) {
        this.worker.postMessage({ type: "dispose", clipId: clip.id });
        this.preparedClips.delete(clip.id);
        this.preparedClipTouchedAtMs.delete(clip.id);
      }

      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
      if (!asset || !clip.assetId) {
        return;
      }

      const needsSourceHydration =
        asset.type === "video" && !hasEmbeddedAssetSource(asset);
      if (needsSourceHydration) {
        if (!this.pendingAssetHydrations.has(asset.id)) {
          this.pendingAssetHydrations.add(asset.id);
          const expectedClipId = clip.id;
          const expectedAssetId = clip.assetId;
          const clipKind = clip.type;
          void ensureAssetSourceLoaded(asset.id)
            .then((hydratedAsset) => {
              if (
                this.disposed ||
                !hydratedAsset ||
                hydratedAsset.id !== expectedAssetId ||
                this.preparedClips.get(expectedClipId) === expectedAssetId
              ) {
                return;
              }

              this.worker.postMessage({
                type: "prepare",
                url: hydratedAsset.src,
                clipId: expectedClipId,
                kind: clipKind,
                file: hydratedAsset.file,
              });
              this.preparedClips.set(expectedClipId, expectedAssetId);
              this.preparedClipTouchedAtMs.set(expectedClipId, performance.now());
            })
            .finally(() => {
              this.pendingAssetHydrations.delete(asset.id);
            });
        }
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
      this.preparedClipTouchedAtMs.set(clip.id, nowMs);
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

  private hasRenderableTextureForClip(clipId: string): boolean {
    const texture = this.sprite.texture;
    return (
      this.currentTextureClipId === clipId &&
      this.sprite.visible &&
      texture !== null &&
      texture !== undefined &&
      texture !== Texture.EMPTY &&
      texture.width > 1 &&
      texture.height > 1
    );
  }

  private shouldRequestFrame(
    activeClip: TimelineClip,
    currentFrameIndex: number,
    renderTimeSeconds: number,
  ): boolean {
    return (
      !this.lastRenderRequest ||
      this.lastRenderRequest.frameIndex !== currentFrameIndex ||
      this.lastRenderRequest.clipId !== activeClip.id ||
      this.lastRenderRequest.assetId !== activeClip.assetId ||
      this.lastRenderRequest.time !== renderTimeSeconds ||
      !this.hasRenderableTextureForClip(activeClip.id)
    );
  }

  private areSameMaskClipList(
    left: readonly MaskTimelineClip[],
    right: readonly MaskTimelineClip[],
  ): boolean {
    if (left === right) {
      return true;
    }
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }

    return true;
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
            const contentSizeChanged = this.applyTexture(
              texture,
              request.clip.id,
              "asset",
            );
            if (contentSizeChanged) {
              await this.resyncMasksForResolvedTexture(
                request.maskClips,
                request.clip,
                request.logicalDimensions,
                request.rawTimeTicks,
                request.assetsById,
              );
            }
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
          if (error instanceof Error && error.name === "AbortError") {
            continue;
          }
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
    options: { timeoutMs?: number } = {},
  ): Promise<LiveFramePayload> {
    this.rejectPendingLiveFrame(createRenderAbortError());

    return awaitStrictFrame<LiveFramePayload>({
      timeoutMs: options.timeoutMs,
      createTimeoutError: (timeoutMs) =>
        createLiveFrameTimeoutError(timeoutMs, clipId),
      registerPending: (pending) => {
        this.pendingLiveFrame = pending;
      },
      unregisterPending: (pending) => {
        if (this.pendingLiveFrame === pending) {
          this.pendingLiveFrame = null;
        }
      },
      sendRequest: () => {
        this.worker.postMessage({
          type: "render",
          time: localTimeSeconds,
          clipId,
          transformTime,
          strict: true,
        });
      },
    });
  }

  private invalidateLivePipeline() {
    this.liveRenderQueue.length = 0;
    this.rejectPendingLiveFrame(createRenderAbortError());
  }

  private resetStalledLiveDecoderWorker() {
    this.rejectPendingLiveFrame(createRenderAbortError());
    this.liveRenderQueue.length = 0;
    this.lastRenderRequest = null;
    this.preparedClips.clear();
    this.preparedClipTouchedAtMs.clear();

    this.worker.terminate();
    this.worker = this.createWorker();
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

  private async updateTexture(
    bitmap: ImageBitmap | null,
    clip: TimelineClip,
    dimensions: { width: number; height: number },
    rawTime: number,
    options: {
      maskClips?: MaskTimelineClip[];
      assetsById?: Map<string, Asset>;
      fps?: number;
    } = {},
  ) {
    if (bitmap) {
      const texture = Texture.from(bitmap);
      const contentSizeChanged = this.applyTexture(texture, clip.id, "asset");
      this.applyClipTransformsForClip(clip, dimensions, rawTime);
      if (contentSizeChanged) {
        await this.resyncMasksForResolvedTexture(
          options.maskClips ?? [],
          clip,
          dimensions,
          rawTime,
          options.assetsById ?? new Map<string, Asset>(),
          options.fps,
        );
      }
    }
  }

  private applyTexture(
    texture: Texture,
    clipId: string,
    sourceKind: "asset" | "text",
  ): boolean {
    const previousTexture = this.sprite.texture;
    const previousWidth =
      previousTexture &&
      previousTexture !== Texture.EMPTY &&
      typeof previousTexture.width === "number"
        ? previousTexture.width
        : 0;
    const previousHeight =
      previousTexture &&
      previousTexture !== Texture.EMPTY &&
      typeof previousTexture.height === "number"
        ? previousTexture.height
        : 0;
    const nextWidth = typeof texture.width === "number" ? texture.width : 0;
    const nextHeight = typeof texture.height === "number" ? texture.height : 0;
    const contentSizeChanged =
      previousWidth !== nextWidth || previousHeight !== nextHeight;

    this.sprite.texture = texture;
    this.retiredTextures.retire(previousTexture);
    this.sprite.visible = true;
    this.currentTextureClipId = clipId;
    this.currentTextureSourceKind = sourceKind;
    return contentSizeChanged;
  }

  private applyClipTransformsForClip(
    clip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
  ) {
    applyClipTransforms(
      this.sprite,
      clip,
      logicalDimensions,
      rawTime,
      clip.type === "text" ? logicalDimensions : undefined,
    );
    this.maskController.syncMaskSpriteTransform();
  }

  private getTextTextureSignature(
    clip: TextTimelineClip,
    logicalDimensions: { width: number; height: number },
  ): string {
    const textData = resolveTextClipData(clip.textData);
    const renderResolution = this.getTextRenderResolution(logicalDimensions);

    return JSON.stringify({
      content: textData.content,
      fontFamily: textData.fontFamily,
      fontSize: textData.fontSize,
      fill: textData.fill,
      align: textData.align,
      logicalWidth: logicalDimensions.width,
      logicalHeight: logicalDimensions.height,
      renderResolution,
    });
  }

  private getTextRenderResolution(
    logicalDimensions: { width: number; height: number },
  ): number {
    if (!this.renderer) {
      return 1;
    }

    const widthRatio =
      this.renderer.width / Math.max(1, logicalDimensions.width);
    const heightRatio =
      this.renderer.height / Math.max(1, logicalDimensions.height);

    return Math.max(1, Math.min(8, Math.max(widthRatio, heightRatio)));
  }

  private createTextTexture(
    clip: TextTimelineClip,
    logicalDimensions: { width: number; height: number },
  ): Texture | null {
    if (!this.renderer) {
      return null;
    }

    const textData = resolveTextClipData(clip.textData);
    const renderResolution = this.getTextRenderResolution(logicalDimensions);
    const text = new Text({
      text: textData.content.length > 0 ? textData.content : " ",
      resolution: renderResolution,
      style: {
        align: textData.align,
        fill: textData.fill,
        fontFamily: textData.fontFamily,
        fontSize: textData.fontSize,
        whiteSpace: "pre-line",
      },
    });

    try {
      return this.renderer.generateTexture({
        target: text,
        resolution: renderResolution,
        clearColor: [0, 0, 0, 0],
      });
    } finally {
      text.destroy();
    }
  }

  private async renderTextClip(
    clip: TextTimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    maskClips: MaskTimelineClip[],
    assetsById: Map<string, Asset>,
    fps?: number,
  ): Promise<void> {
    const nextSignature = this.getTextTextureSignature(clip, logicalDimensions);
    const hasReusableTextTexture =
      this.currentTextureSourceKind === "text" &&
      this.currentTextTextureSignature === nextSignature &&
      this.sprite.texture !== Texture.EMPTY;

    if (hasReusableTextTexture) {
      this.sprite.visible = true;
      this.currentTextureClipId = clip.id;
    } else {
      const texture = this.createTextTexture(clip, logicalDimensions);
      if (!texture) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        return;
      }

      this.applyTexture(texture, clip.id, "text");
      this.currentTextTextureSignature = nextSignature;
    }

    this.applyClipTransformsForClip(clip, logicalDimensions, rawTime);

    try {
      await this.maskController.syncMaskClips(
        maskClips,
        clip,
        logicalDimensions,
        rawTime,
        assetsById,
        { fps, skipSam2FrameRender: true },
      );
    } catch (error) {
      console.warn("Failed to sync text clip masks", error);
    }
  }

  private async resyncMasksForResolvedTexture(
    maskClips: MaskTimelineClip[],
    clip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    assetsById: Map<string, Asset>,
    fps?: number,
  ): Promise<void> {
    if (maskClips.length === 0) {
      return;
    }

    try {
      await this.maskController.syncMaskClips(
        maskClips,
        clip,
        logicalDimensions,
        rawTime,
        assetsById,
        { fps, skipSam2FrameRender: true },
      );
    } catch (error) {
      console.warn("Failed to resync masks after texture update", error);
    }
  }

  private async resyncMasksForLatestAssetMaskFrame(): Promise<void> {
    if (this.pendingAssetMaskFrameResync) {
      return this.pendingAssetMaskFrameResync;
    }

    const context = this.latestMaskSyncContext;
    if (!context || this.disposed) {
      return;
    }

    this.pendingAssetMaskFrameResync = this.maskController
      .syncMaskClips(
        context.maskClips,
        context.clip,
        context.logicalDimensions,
        context.rawTimeTicks,
        context.assetsById,
        { fps: context.fps, skipSam2FrameRender: true },
      )
      .catch((error) => {
        console.warn("Failed to resync masks after mask frame update", error);
      })
      .finally(() => {
        this.pendingAssetMaskFrameResync = null;
      });

    return this.pendingAssetMaskFrameResync;
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
    this.applyClipTransformsForClip(
      activeClip,
      logicalDimensions,
      rawTimeSeconds,
    );
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
    this.inFlightSynchronizedRender = null;

    this.rejectPendingFrame(createRenderAbortError());
    this.rejectPendingLiveFrame(createRenderAbortError());
    this.invalidateLivePipeline();

    this.retiredTextures.cancel();
    const currentTexture = this.sprite.texture;
    this.sprite.texture = Texture.EMPTY;
    destroyTexture(currentTexture);
    this.retiredTextures.flush();

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
    this.currentTextureSourceKind = null;
    this.currentTextTextureSignature = null;
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

}
