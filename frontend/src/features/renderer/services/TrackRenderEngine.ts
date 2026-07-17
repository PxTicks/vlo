import { Container, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type {
  TimelineClip,
  MaskTimelineClip,
  TextTimelineClip,
  ExtensionTimelineClip,
  ClipTransform,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import { mediaSecondsToTickExact } from "../utils/mediaTime";
import {
  resolveClipRenderTime,
  resolveClipRenderTimeFromEffectiveTick,
} from "../utils/clipRenderTime";
import {
  createSourceFrameSyncRef,
  isSourceFrameIntentCurrent,
  type SourceFrameSyncIntent,
  type SourceFrameSyncRef,
} from "../utils/sourceFrameSync";
import {
  findActiveClipAtTicks,
  resolveLiveActiveClip,
} from "../utils/clipLookup";
import { applyClipTransforms } from "../../transformations/applyTransformations";
import { createFrameFilterRenderContext } from "../../transformations/catalogue/renderSampleContext";
import { getTemporalSampleCacheIdentity } from "../../transformations/catalogue/temporalRenderingRequirements";
import type {
  FilterRenderContext,
  FilterRenderMode,
} from "../../transformations/catalogue/types";
import { releaseTransformationFilters } from "../../transformations/catalogue/filterRuntime";
import { TemporalRenderBranch } from "./TemporalRenderCoordinator";
import {
  planTransformRender,
  type FilterRenderStep,
} from "../../transformations/effectMaskRenderPlan";
import {
  buildResolvedFilterOpLookupWithTime,
  type ResolvedFilterOp,
} from "../../transformations/effectMaskFilterOps";
import { SpriteClipMaskController } from "../../masks/runtime/SpriteClipMaskController";
import { MaskedEffectRenderer } from "../../masks/runtime/MaskedEffectRenderer";
import { useDebugStore } from "../../../shared/debug/useDebugStore";
import { ticksPerFrame } from "../../../core/time/frameGrid";
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
import {
  createDecoderRequestDiagnostics,
  logDecoderRequestAborted,
  logDecoderRequestSent,
  logDecoderRequestTimeout,
} from "../utils/decoderDiagnostics";
import {
  getSharedDecoderWorkerPool,
  type DecoderLease,
  type DecoderStallResolution,
  type DecoderWorkerPool,
} from "./DecoderWorkerPool";
import {
  createTextTexture,
  getTextTextureSignature,
} from "./textTextureRenderer";
import type { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import type { SharedTextureHandle } from "./SharedTextureStore";
import type {
  FrameExecutionPolicy,
  ResolvedClipFrameJob,
} from "./framePlanning";
import {
  extensionEntityProviderRegistry,
  TrustedExtensionEntityRenderer,
} from "../../extensions/entities/publicApi";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

function createLiveFrameTimeoutError(timeoutMs: number, clipId: string): Error {
  const error = new Error(
    `Timed out waiting ${timeoutMs}ms for live frame ${clipId}`,
  );
  error.name = "TimeoutError";
  (error as { source?: string }).source = "track-live-frame";
  return error;
}

function isLiveFrameTimeoutError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "TimeoutError" &&
    (error as { source?: string }).source === "track-live-frame"
  );
}

function getSourceScheme(asset: Asset): string {
  if (asset.file) {
    return "blob-file";
  }

  const separatorIndex = asset.src.indexOf(":");
  return separatorIndex > 0 ? asset.src.slice(0, separatorIndex) : "relative";
}

interface LiveRenderRequest {
  clip: TimelineClip;
  maskClips: MaskTimelineClip[];
  assetsById: Map<string, Asset>;
  logicalDimensions: { width: number; height: number };
  sourceFrame: SourceFrameSyncRef;
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
  sourceFrame: SourceFrameSyncRef;
  fps?: number;
}

export function resolveClipTransformContentSize(
  clip: TimelineClip,
  logicalDimensions: { width: number; height: number },
  contentSizeOverride?: { width: number; height: number },
  sourceSize?: { width: number; height: number },
): { width: number; height: number } | undefined {
  return (
    contentSizeOverride ??
    (clip.type === "text" ? logicalDimensions : sourceSize)
  );
}

interface TrackRenderEngineOptions {
  trackId?: string;
  adjustmentEffectResolver?: AdjustmentEffectResolver | null;
  decoderPool?: DecoderWorkerPool;
}

function isDecoderRenderableClip(
  clip: TimelineClip | undefined | null,
): clip is Extract<TimelineClip, { type: "video" | "image" }> {
  return clip?.type === "video" || clip?.type === "image";
}

function getDecoderSourceKind(
  clip: TimelineClip,
): "video" | "image" | null {
  if (clip.type === "video" || clip.type === "image") {
    return clip.type;
  }

  return null;
}

export function createExtensionPlaceholderClip(
  clip: ExtensionTimelineClip,
  failureMessage?: string,
): TextTimelineClip {
  const providerId = `${clip.extensionPayload.extensionId}/${clip.extensionPayload.typeId}`;
  const availability = extensionEntityProviderRegistry.getAvailability(
    clip.extensionPayload,
  );
  const presentation =
    failureMessage
      ? {
          title: failureMessage,
          fill: "#fee2e2",
          strokeColor: "#991b1b",
        }
      : availability === "missing"
      ? {
          title: "Missing extension",
          fill: "#ffedd5",
          strokeColor: "#7c2d12",
        }
      : availability === "incompatible"
        ? {
            title: "Incompatible extension",
            fill: "#fee2e2",
            strokeColor: "#991b1b",
          }
        : availability === "renderer_unavailable"
          ? {
              title: "Extension renderer unavailable",
              fill: "#dbeafe",
              strokeColor: "#1e3a8a",
            }
          : {
              title: "Extension renderer failed",
              fill: "#fee2e2",
              strokeColor: "#991b1b",
            };
  return {
    ...clip,
    type: "text",
    textData: {
      content: `${presentation.title}\n${providerId}`,
      fontFamily: "Arial",
      fontSize: 64,
      fill: presentation.fill,
      align: "center",
      strokeColor: presentation.strokeColor,
      strokeWidth: 4,
    },
  };
}

function getTextRenderableClip(
  clip: TimelineClip,
): TextTimelineClip | null {
  if (clip.type === "text") return clip;
  if (
    clip.type === "extension" &&
    extensionEntityProviderRegistry.getAvailability(clip.extensionPayload) !==
      "available"
  ) {
    return createExtensionPlaceholderClip(clip);
  }
  return null;
}

/**
 * Health tally for strict (export-style) frame replies. Null replies are
 * encoded as black/frozen frames downstream with no error raised, so callers
 * that produce deliverable output (export, generation inputs) need this to
 * detect silently-degraded renders.
 */
export interface StrictRenderHealth {
  replies: number;
  nullFrames: number;
  missingRendererFrames: number;
  errorFrames: number;
}

export function createEmptyStrictRenderHealth(): StrictRenderHealth {
  return {
    replies: 0,
    nullFrames: 0,
    missingRendererFrames: 0,
    errorFrames: 0,
  };
}

/** True when every strict reply was frameless — the rendered output is blank. */
export function isBlankStrictRenderHealth(
  health: StrictRenderHealth,
): boolean {
  return health.replies > 0 && health.nullFrames === health.replies;
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
  private static readonly LIVE_RENDER_RECOVERY_ATTEMPTS = 1;
  private static readonly LIVE_DECODER_RESET_TIMEOUTS = 2;

  public readonly sprite: Sprite;
  public readonly container: Container;
  private readonly presentationContainer: Container;
  private readonly lease: DecoderLease;
  private readonly renderer: Renderer | null;
  private readonly trackId: string | null;
  private readonly adjustmentEffectResolver: AdjustmentEffectResolver | null;

  // State
  private preparedClips = new Map<string, string>(); // clipId -> assetId
  private preparedClipTouchedAtMs = new Map<string, number>(); // clipId -> perf.now()
  private currentTextureClipId: string | null = null;
  private currentTextureSourceKind:
    | "asset"
    | "text"
    | "extension"
    | null = null;
  private currentContentSizeOverride: {
    clipId: string;
    size: { width: number; height: number };
  } | null = null;
  // Frame-scoped render-sample metadata for time-dependent filters. Set at each
  // render entry point (live `update`, export/live frame job) and read by the
  // clip applicators so a sample/history filter animates from canonical visual
  // time instead of the synthesized zero-time stateless fallback.
  private currentRenderFps = 30;
  private currentRenderMode: FilterRenderMode = "preview";
  private currentRenderContext: FilterRenderContext | null = null;
  private readonly effectMaskTemporalBranch = new TemporalRenderBranch();
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
  private pendingLiveFrameRequestId: string | null = null;
  private nextLiveFrameRequestId = 0;
  private liveDecoderTimeoutCount = 0;
  private strictRenderHealth = createEmptyStrictRenderHealth();
  private readonly reportedStrictFrameIssueClipIds = new Set<string>();

  // Live synchronized pipeline
  private liveRenderQueue: LiveRenderRequest[] = [];
  private pendingAssetHydrations = new Set<string>();
  private livePipelineBusy = false;
  private inFlightSynchronizedRender: InFlightSynchronizedRender | null = null;
  private liveRenderGeneration = 0;
  private synchronizedRenderGeneration = 0;
  private currentLiveSourceFrameIntent: SourceFrameSyncIntent | null = null;
  private currentSynchronizedSourceFrameIntent: SourceFrameSyncIntent | null =
    null;
  private plannedRenderGeneration = 0;
  private currentPlannedSourceFrameIntent: SourceFrameSyncIntent | null = null;

  // Deferred texture cleanup to avoid null-source races during hot swaps
  private readonly retiredTextures = new RetiredTextureQueue(
    () => this.sprite.texture,
  );
  // Effect-level masking renders the filter chain offscreen. `maskedEffectRenderer`
  // owns the chain's render-texture pool; `effectSourceTexture` retains the
  // unfiltered source so a paused recomposite re-renders from source (not from
  // the displayed effect output) and so texture retiring always targets the
  // source, never a pool-owned effect output.
  private readonly maskedEffectRenderer: MaskedEffectRenderer | null;
  private readonly extensionEntityRenderer:
    | TrustedExtensionEntityRenderer
    | null;
  private effectSourceTexture: Texture | null = null;
  private currentSharedTextureHandle: SharedTextureHandle | null = null;
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
    options: TrackRenderEngineOptions = {},
  ) {
    this.renderer = renderer ?? null;
    this.trackId = options.trackId ?? null;
    this.adjustmentEffectResolver = options.adjustmentEffectResolver ?? null;
    this.onFrameReady = onFrameReady;
    this.lease = (options.decoderPool ?? getSharedDecoderWorkerPool()).acquireLease(
      { label: this.trackId ?? undefined },
      {
        onReady: () => {},
        onFrame: (message) => {
          this.handleLeaseFrame(message);
        },
        onWorkerError: (error) => {
          this.handleLeaseWorkerError(error);
        },
        onSourceEvicted: (clipId) => {
          this.handleDecoderSourceEvicted(clipId);
        },
      },
    );

    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;

    // The outer container is the track node registered with the scene
    // presentation DAG. The inner container is the final per-track
    // presentation boundary: the primary sprite and effect-created companion
    // sprites live inside it, while mask sources remain external siblings.
    // Spatial masks target the inner container so they clip the complete
    // rendered result without feeding presentation state back into DAG source
    // or effect-texture identities.
    this.container = new Container();
    this.presentationContainer = new Container();
    this.presentationContainer.addChild(this.sprite);
    this.container.addChild(this.presentationContainer);
    this.maskedEffectRenderer = renderer
      ? new MaskedEffectRenderer(renderer)
      : null;
    this.extensionEntityRenderer = renderer
      ? new TrustedExtensionEntityRenderer(renderer)
      : null;
    this.maskController = new SpriteClipMaskController(
      this.sprite,
      renderer,
      this.container,
      () => {
        void this.resyncMasksForLatestAssetMaskFrame();
      },
      this.presentationContainer,
    );
    if (renderer) {
      // Brush masks render their painted bitmap into a Pixi RenderTexture via
      // this shared renderer. Wiring it once here keeps the registry decoupled
      // from React.
      void import("../../masks/runtime/brushBufferRegistry").then(
        ({ setBrushRenderer }) => setBrushRenderer(renderer),
      );
    }
    this.container.zIndex = zIndex;
  }

  public addTo(parent: Container) {
    parent.addChild(this.container);
  }

  public setZIndex(zIndex: number) {
    this.container.zIndex = zIndex;
  }

  /**
   * Presentation lookup resolves through the active clip so static rebases and
   * ripple placement both feed the renderer the stored-track tick that should
   * play at this presentation tick.
   */
  public resolveActiveClipAtPresentation(
    trackClips: TimelineClip[],
    presentationTick: number,
  ): {
    activeClip: TimelineClip;
    effectiveTick: number;
    presentationStart: number;
  } | null {
    if (!this.trackId || !this.adjustmentEffectResolver) {
      const activeClip = findActiveClipAtTicks(trackClips, presentationTick);
      return activeClip
        ? {
            activeClip,
            effectiveTick: presentationTick,
            presentationStart: activeClip.start,
          }
        : null;
    }
    // The lookup owns identity + timing only; `resolveLiveActiveClip` re-binds
    // its result to the live `trackClips` so transform/property data is current
    // (the cache is invalidated on a React effect and would otherwise serve a
    // stale clip — making committed edits revert). See clipLookup.
    const resolved = resolveLiveActiveClip(
      this.adjustmentEffectResolver,
      this.trackId,
      trackClips,
      presentationTick,
    );
    return resolved
      ? {
          activeClip: resolved.clip,
          effectiveTick: resolved.effectiveTick,
          presentationStart: resolved.presentationStart,
        }
      : null;
  }

  /**
   * For callers that already know the active clip (e.g. forceUpdateTransforms
   * after a viewport-only change) and just need the effective track tick.
   */
  public resolveEffectiveTrackTickForClip(
    clip: TimelineClip,
    presentationTick: number,
  ): number {
    if (!this.adjustmentEffectResolver) {
      return presentationTick;
    }
    return this.adjustmentEffectResolver
      .getPresentationLookup()
      .resolveEffectiveTrackTickWithinClip(clip, presentationTick);
  }

  public resolveFrameJob(options: {
    epoch: number;
    presentationTick: number;
    trackClips: TimelineClip[];
    maskClipsByParent: ReadonlyMap<string, MaskTimelineClip[]>;
    assetsById: ReadonlyMap<string, Asset>;
    logicalDimensions: { width: number; height: number };
    fps: number;
  }): ResolvedClipFrameJob | null {
    const resolved = this.resolveActiveClipAtPresentation(
      options.trackClips,
      options.presentationTick,
    );
    if (!resolved || !this.trackId) {
      this.currentPlannedSourceFrameIntent = null;
      return null;
    }

    const { activeClip, effectiveTick } = resolved;
    const asset = isAssetBackedClip(activeClip)
      ? options.assetsById.get(activeClip.assetId)
      : undefined;
    const fps =
      asset?.fps && asset.fps > 0 ? asset.fps : Math.max(1, options.fps);
    this.plannedRenderGeneration += 1;
    const renderTime = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: options.presentationTick,
      effectiveTrackTick: effectiveTick,
    });
    const sourceFrame = createSourceFrameSyncRef({
      clip: activeClip,
      assetId: isAssetBackedClip(activeClip) ? activeClip.assetId : null,
      effectiveTrackTick: effectiveTick,
      fps,
      generation: this.plannedRenderGeneration,
    });
    this.currentPlannedSourceFrameIntent = {
      key: sourceFrame.key,
      generation: sourceFrame.generation,
    };

    const source = this.effectSourceTexture;
    const contentSize =
      source && source !== Texture.EMPTY && source.width > 0 && source.height > 0
        ? { width: source.width, height: source.height }
        : options.logicalDimensions;

    return {
      id: `${options.epoch}:${this.trackId}:${activeClip.id}`,
      trackId: this.trackId,
      activeClip,
      effectiveTrackTick: effectiveTick,
      rawClipTick: renderTime.clipVisualTimeTicks,
      sourceFrame,
      maskClips: options.maskClipsByParent.get(activeClip.id) ?? [],
      logicalDimensions: options.logicalDimensions,
      contentSize,
      fps,
    };
  }

  public getCurrentPlannedSourceFrameIntent(): SourceFrameSyncIntent | null {
    return this.currentPlannedSourceFrameIntent;
  }

  /**
   * Composite placements retain an assetId only as persisted migration data.
   * Once source policy selects a validated bake, rebuild the immutable job
   * against that cache asset so decode/preparation never reads the placement's
   * legacy pointer.
   */
  public retargetResolvedFrameJobAsset(
    job: ResolvedClipFrameJob,
    asset: Asset,
    fallbackFps: number,
  ): ResolvedClipFrameJob {
    if (!isAssetBackedClip(job.activeClip)) return job;
    const activeClip = { ...job.activeClip, assetId: asset.id };
    const fps = asset.fps && asset.fps > 0 ? asset.fps : Math.max(1, fallbackFps);
    const sourceFrame = createSourceFrameSyncRef({
      clip: activeClip,
      assetId: asset.id,
      effectiveTrackTick: job.effectiveTrackTick,
      fps,
      generation: job.sourceFrame.generation,
    });
    this.currentPlannedSourceFrameIntent = {
      key: sourceFrame.key,
      generation: sourceFrame.generation,
    };
    return { ...job, activeClip, sourceFrame, fps };
  }

  public isFrameJobCurrent(job: ResolvedClipFrameJob): boolean {
    return isSourceFrameIntentCurrent(this.currentPlannedSourceFrameIntent, {
      key: job.sourceFrame.key,
      generation: job.sourceFrame.generation,
    });
  }

  public prepareResolvedFrameJob(
    job: ResolvedClipFrameJob,
    trackClips: TimelineClip[],
    assets: Asset[],
  ): boolean {
    const preparationClips = trackClips.map((clip) =>
      clip.id === job.activeClip.id ? job.activeClip : clip,
    );
    this.syncPreparedClips(
      job.effectiveTrackTick,
      preparationClips,
      assets,
      performance.now(),
      false,
    );
    return (
      !isDecoderRenderableClip(job.activeClip) ||
      this.preparedClips.get(job.activeClip.id) === job.activeClip.assetId
    );
  }

  public async awaitResolvedFrameJobPreparation(
    job: ResolvedClipFrameJob,
    assetsById: Map<string, Asset>,
  ): Promise<void> {
    if (
      !isDecoderRenderableClip(job.activeClip) ||
      this.preparedClips.get(job.activeClip.id) === job.activeClip.assetId
    ) {
      return;
    }
    await this.prepareClipForStrictRender(
      job.activeClip,
      assetsById,
      performance.now(),
    );
  }

  public async decodeResolvedSourceFrame(
    job: ResolvedClipFrameJob,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageBitmap | null> {
    if (!isDecoderRenderableClip(job.activeClip)) {
      return null;
    }
    if (options.signal?.aborted) {
      throw createRenderAbortError();
    }
    if (this.pendingReject) {
      this.rejectPendingFrame(
        new Error("Concurrent strict frame decode is not supported per track"),
      );
    }

    return new Promise<ImageBitmap | null>((resolve, reject) => {
      let isSettled = false;
      const settle = <T extends unknown[]>(handler: (...args: T) => void) => {
        return (...args: T) => {
          if (isSettled) return;
          isSettled = true;
          this.clearPendingFrameState();
          handler(...args);
        };
      };
      const resolveFrame = settle(resolve);
      const rejectFrame = settle(reject);

      if (options.signal) {
        const onAbort = () => rejectFrame(createRenderAbortError());
        options.signal.addEventListener("abort", onAbort, { once: true });
        this.pendingAbortCleanup = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pendingResolve = resolveFrame;
      this.pendingReject = rejectFrame;
      this.lease.render({
        time: job.sourceFrame.snappedTimeSeconds,
        clipId: job.activeClip.id,
        transformTime: job.rawClipTick,
        strict: true,
      });
    });
  }

  public async presentResolvedFrameJob(
    job: ResolvedClipFrameJob,
    sourceHandle: SharedTextureHandle | null,
    assetsById: Map<string, Asset>,
    policy: FrameExecutionPolicy,
  ): Promise<boolean> {
    this.currentRenderFps = job.fps;
    this.currentRenderMode = policy.mode === "export" ? "export" : "preview";
    this.currentRenderContext = policy.render ?? null;
    if (policy.mode === "export" && policy.signal?.aborted) {
      sourceHandle?.release();
      throw createRenderAbortError();
    }
    if (policy.mode === "live" && !this.isFrameJobCurrent(job)) {
      sourceHandle?.release();
      return false;
    }
    const contentSizeOverride = job.compositeSource ? job.contentSize : null;
    this.setCurrentContentSizeOverride(job.activeClip.id, contentSizeOverride);

    const presentationClip: TimelineClip =
      job.transitionTransforms && job.transitionTransforms.length > 0
        ? {
            ...job.activeClip,
            transformations: [
              ...(job.activeClip.transformations ?? []),
              ...job.transitionTransforms,
            ],
          }
        : job.activeClip;
    const textRenderableClip = getTextRenderableClip(presentationClip);

    this.latestMaskSyncContext = {
      maskClips: [...job.maskClips],
      clip: textRenderableClip ?? presentationClip,
      logicalDimensions: job.logicalDimensions,
      rawTimeTicks: job.rawClipTick,
      assetsById,
      sourceFrame: job.sourceFrame,
      fps: job.fps,
    };

    if (textRenderableClip) {
      sourceHandle?.release();
      await this.renderTextClip(
        textRenderableClip,
        job.logicalDimensions,
        job.rawClipTick,
        [...job.maskClips],
        assetsById,
        job.sourceFrame,
        job.fps,
      );
      return true;
    }

    if (presentationClip.type === "extension") {
      const rendered = await this.renderExtensionClip(
        presentationClip,
        job.logicalDimensions,
        job.effectiveTrackTick,
        job.rawClipTick,
        [...job.maskClips],
        assetsById,
        job.sourceFrame,
        job.fps,
        policy.mode === "export",
      );
      if (rendered) {
        sourceHandle?.release();
        return true;
      }
    }

    if (!isDecoderRenderableClip(presentationClip)) {
      sourceHandle?.release();
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return true;
    }

    if (!sourceHandle || sourceHandle.texture === Texture.EMPTY) {
      sourceHandle?.release();
      // An empty decode means no content exists at this source time. In export
      // we must render black rather than freeze the active clip's last decoded
      // frame: a timeline selection can sample past a clip's decodable content
      // (its source ends before the selection/footprint does), and holding the
      // stale texture ships duplicated frames instead of the expected black.
      // Live preview still keeps the last good frame for the same clip so a
      // transient decode gap during scrub/playback doesn't flash to black.
      if (
        policy.mode === "export" ||
        this.currentTextureClipId !== job.activeClip.id
      ) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        this.maskController.clear();
      }
      return true;
    }

    await this.maskController.syncMaskClips(
      [...job.maskClips],
      presentationClip,
      job.logicalDimensions,
      job.rawClipTick,
      assetsById,
      {
        fps: job.fps,
        sourceFrame: job.sourceFrame,
        waitForSam2: true,
      },
    );
    if (policy.mode === "export" && policy.signal?.aborted) {
      sourceHandle.release();
      throw createRenderAbortError();
    }
    if (policy.mode === "live" && !this.isFrameJobCurrent(job)) {
      sourceHandle.release();
      return false;
    }

    const contentSizeChanged = this.applyTexture(
      sourceHandle.texture,
      job.activeClip.id,
      "asset",
      sourceHandle,
    );
    if (contentSizeChanged) {
      await this.resyncMasksForResolvedTexture(
        [...job.maskClips],
        presentationClip,
        job.logicalDimensions,
        job.rawClipTick,
        assetsById,
        job.sourceFrame,
        job.fps,
      );
    }
    this.applyClipTransformsForClip(
      presentationClip,
      job.logicalDimensions,
      job.rawClipTick,
      contentSizeOverride ?? undefined,
    );
    return true;
  }

  public presentBlankFrame(): void {
    this.currentPlannedSourceFrameIntent = null;
    this.currentContentSizeOverride = null;
    this.sprite.visible = false;
    this.currentTextureClipId = null;
    this.maskController.clear();
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
    this.currentRenderFps = fps;
    this.currentRenderMode = "preview";
    this.currentRenderContext = null;
    const nowMs = performance.now();
    const isLikelyScrubbing = this.detectScrubbing(currentTime, fps, nowMs);
    const resolved = this.resolveActiveClipAtPresentation(
      trackClips,
      currentTime,
    );
    const effectiveTick = resolved?.effectiveTick ?? currentTime;
    const assetById = this.syncPreparedClips(
      effectiveTick,
      trackClips,
      assets,
      nowMs,
      isLikelyScrubbing,
    );

    // 3. Identify Active Clip — driven by per-clip presentation lookup.
    const activeClip = resolved?.activeClip;

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
    const renderTime = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: currentTime,
      effectiveTrackTick: effectiveTick,
    });
    const { clipVisualTimeTicks, sourceTimeSeconds } = renderTime;

    if (typeof sourceTimeSeconds !== "number" || isNaN(sourceTimeSeconds)) {
      if (this.pendingResolve) {
        const resolvePending = this.pendingResolve;
        this.clearPendingFrameState();
        resolvePending(null);
      }
      return Promise.resolve();
    }

    // Sync masks from first-class mask clips
    const maskClips = maskClipsByParent.get(activeClip.id) ?? [];

    const textRenderableClip = getTextRenderableClip(activeClip);
    if (textRenderableClip) {
      this.invalidateLivePipeline();
      const sourceFrame = this.advanceLiveSourceFrameIntent(
        this.createLiveSourceFrameRef(activeClip, null, effectiveTick, fps),
      );
      this.latestMaskSyncContext = {
        maskClips,
        clip: textRenderableClip,
        logicalDimensions,
        rawTimeTicks: clipVisualTimeTicks,
        assetsById: assetById,
        sourceFrame,
        fps,
      };

      if (!shouldRender) {
        if (
          this.sprite.visible &&
          this.currentTextureClipId === activeClip.id
        ) {
          this.applyClipTransformsForClip(
            textRenderableClip,
            logicalDimensions,
            clipVisualTimeTicks,
          );
        }
        return Promise.resolve();
      }

      return this.renderTextClip(
        textRenderableClip,
        logicalDimensions,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      ).catch((error) => {
        console.warn("Failed to render text clip", error);
      });
    }

    if (activeClip.type === "extension") {
      this.invalidateLivePipeline();
      const sourceFrame = this.advanceLiveSourceFrameIntent(
        this.createLiveSourceFrameRef(activeClip, null, effectiveTick, fps),
      );
      this.latestMaskSyncContext = {
        maskClips,
        clip: activeClip,
        logicalDimensions,
        rawTimeTicks: clipVisualTimeTicks,
        assetsById: assetById,
        sourceFrame,
        fps,
      };

      if (!shouldRender) {
        if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
          this.applyClipTransformsForClip(
            activeClip,
            logicalDimensions,
            clipVisualTimeTicks,
          );
        }
        return Promise.resolve();
      }

      return this.renderExtensionClip(
        activeClip,
        logicalDimensions,
        currentTime,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      ).then((rendered) => {
        if (!rendered) {
          this.sprite.visible = false;
          this.currentTextureClipId = null;
          this.maskController.clear();
        }
      });
    }

    if (!isDecoderRenderableClip(activeClip)) {
      this.invalidateLivePipeline();
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return Promise.resolve();
    }

    const asset = assetById.get(activeClip.assetId);
    const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : fps;
    const sourceFrame = this.createLiveSourceFrameRef(
      activeClip,
      activeClip.assetId,
      effectiveTick,
      clipFps,
    );

    this.latestMaskSyncContext = {
      maskClips,
      clip: activeClip,
      logicalDimensions,
      rawTimeTicks: clipVisualTimeTicks,
      assetsById: assetById,
      sourceFrame,
      fps: clipFps,
    };

    // 6. Send Render Request
    // Optimization: Don't request same frame twice (Live Mode only)
    // For Export, we usually force request or trust the caller loop
    const shouldSend =
      this.shouldRequestFrame(
        activeClip,
        sourceFrame.frameIndex,
        sourceFrame.snappedTimeSeconds,
      ) || this.pendingResolve !== null; // Always send if strictly awaiting (Export)

    if (shouldSend && shouldRender) {
      const requestSourceFrame = this.advanceLiveSourceFrameIntent(sourceFrame);
      this.lastRenderRequest = {
        time: requestSourceFrame.snappedTimeSeconds,
        clipId: activeClip.id,
        assetId: activeClip.assetId,
        frameIndex: requestSourceFrame.frameIndex,
      };
      this.latestMaskSyncContext = {
        ...this.latestMaskSyncContext,
        sourceFrame: requestSourceFrame,
      };

      // Join content frame + asset-backed masks at the same timeline time.
      // Requests are committed in enqueue order.
      this.enqueueLiveRenderRequest({
        clip: activeClip,
        maskClips,
        assetsById: assetById,
        logicalDimensions,
        sourceFrame: requestSourceFrame,
        enqueuedAtMs: nowMs,
      });
    } else if (!shouldSend || !shouldRender) {
      // Keep transforms/filters responsive without requesting a new SAM2 frame.
      const currentSourceFrame = this.advanceLiveSourceFrameIntent(sourceFrame);
      this.latestMaskSyncContext = {
        ...this.latestMaskSyncContext,
        sourceFrame: currentSourceFrame,
      };
      void this.maskController
        .syncMaskClips(
          maskClips,
          activeClip,
          logicalDimensions,
          clipVisualTimeTicks,
          assetById,
          {
            fps: clipFps,
            sourceFrame: currentSourceFrame,
            skipSam2FrameRender: true,
          },
        )
        .catch((error) => {
          console.warn("Failed to sync live masks", error);
        });
    }

    // 7. Apply Immediate Transforms (even if texture hasn't updated yet)
    // This ensures moving/scaling feels responsive even if the frame decoding lags
    if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
      this.applyClipTransformsForClip(
        activeClip,
        logicalDimensions,
        clipVisualTimeTicks,
        this.getCurrentContentSizeOverride(activeClip.id),
      );
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
    const resolved = this.resolveActiveClipAtPresentation(
      trackClips,
      currentTime,
    );
    if (!resolved) {
      this.invalidateLivePipeline();
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return;
    }
    const { activeClip, effectiveTick } = resolved;

    const renderTime = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: currentTime,
      effectiveTrackTick: effectiveTick,
    });
    const { clipVisualTimeTicks, sourceTimeSeconds } = renderTime;

    if (typeof sourceTimeSeconds !== "number" || isNaN(sourceTimeSeconds)) {
      return;
    }

    const maskClips = maskClipsByParent.get(activeClip.id) ?? [];
    const textRenderableClip = getTextRenderableClip(activeClip);
    if (textRenderableClip) {
      const assetById = new Map<string, Asset>(
        assets.map((asset) => [asset.id, asset] as const),
      );
      const sourceFrame = this.setSynchronizedSourceFrameIntent(
        this.createSynchronizedSourceFrameRef(
          activeClip,
          null,
          effectiveTick,
          fps,
          this.synchronizedRenderGeneration,
        ),
      );
      this.latestMaskSyncContext = {
        maskClips,
        clip: textRenderableClip,
        logicalDimensions,
        rawTimeTicks: clipVisualTimeTicks,
        assetsById: assetById,
        sourceFrame,
        fps,
      };
      await this.renderTextClip(
        textRenderableClip,
        logicalDimensions,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      );
      return;
    }

    if (activeClip.type === "extension") {
      const assetById = new Map<string, Asset>(
        assets.map((asset) => [asset.id, asset] as const),
      );
      const sourceFrame = this.setSynchronizedSourceFrameIntent(
        this.createSynchronizedSourceFrameRef(
          activeClip,
          null,
          effectiveTick,
          fps,
          this.synchronizedRenderGeneration,
        ),
      );
      const rendered = await this.renderExtensionClip(
        activeClip,
        logicalDimensions,
        currentTime,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      );
      if (!rendered) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        this.maskController.clear();
      }
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

    const generation = this.createSynchronizedRenderGeneration();
    const renderPromise = this.renderSynchronizedPlaybackFrameInternal(
      trackClips,
      assets,
      logicalDimensions,
      {
        activeClip,
        effectiveTick,
        fps,
        generation,
        maskClips,
        clipVisualTimeTicks,
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

  /**
   * Re-sync masks for the clip visible at the current paused time without
   * re-requesting the content frame. Used when the mask set changes while
   * paused (a mask is added, a SAM2/asset mask result arrives, a mask's mode
   * is toggled) so the applied mask appears immediately instead of waiting for
   * the next playhead move.
   *
   * Unlike the transform-only paused paths this does NOT skip the asset-mask
   * frame render, so freshly arrived SAM2/asset masks kick off their frame
   * fetch here; the resulting `onAssetMaskFrameReady` callback re-syncs once
   * the frame decodes. The paused Pixi ticker flushes the updated scene graph.
   */
  public async refreshMasksAtPausedFrame(
    currentTime: number,
    trackClips: TimelineClip[],
    maskClipsByParent: Map<string, MaskTimelineClip[]>,
    assets: Asset[],
    logicalDimensions: { width: number; height: number },
    options: { fps?: number } = {},
  ): Promise<void> {
    if (this.disposed) return;
    const { fps = 30 } = options;

    const resolved = this.resolveActiveClipAtPresentation(
      trackClips,
      currentTime,
    );
    if (!resolved) return;
    const { activeClip, effectiveTick } = resolved;

    // Only clips that own a rendered texture can carry an applied mask; bail on
    // anything we are not currently displaying so we never composite against a
    // stale frame.
    if (!this.hasRenderableTextureForClip(activeClip.id)) {
      return;
    }

    const { clipVisualTimeTicks } = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: currentTime,
      effectiveTrackTick: effectiveTick,
    });
    const maskClips = maskClipsByParent.get(activeClip.id) ?? [];
    const assetById = new Map(
      assets.map((asset) => [asset.id, asset] as const),
    );
    const asset = isAssetBackedClip(activeClip)
      ? assetById.get(activeClip.assetId)
      : undefined;
    const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : fps;
    const sourceFrame = this.advanceLiveSourceFrameIntent(
      createSourceFrameSyncRef({
        clip: activeClip,
        assetId: isAssetBackedClip(activeClip) ? activeClip.assetId : null,
        effectiveTrackTick: effectiveTick,
        fps: clipFps,
        generation: this.liveRenderGeneration,
      }),
    );
    this.latestMaskSyncContext = {
      maskClips,
      clip: activeClip,
      logicalDimensions,
      rawTimeTicks: clipVisualTimeTicks,
      assetsById: assetById,
      sourceFrame,
      fps: clipFps,
    };

    try {
      await this.maskController.syncMaskClips(
        maskClips,
        activeClip,
        logicalDimensions,
        clipVisualTimeTicks,
        assetById,
        { fps: clipFps, sourceFrame, skipSam2FrameRender: false },
      );
    } catch (error) {
      console.warn("Failed to refresh paused masks", error);
    }

    if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
      // Re-run the clip transforms now that masks are re-synced so a paused edit
      // to a filter (e.g. blur strength) or to the mask itself recomposites the
      // offscreen effect-mask chain immediately, instead of waiting for the next
      // scrub. Crucially this runs AFTER syncMaskClips above: the effect chain's
      // coverage resolves against the freshly synced mask set — the same
      // mask-then-effect ordering the live render paths rely on. The displayed
      // effect output is recomputed from `effectSourceTexture` (the unfiltered
      // source, untouched by the previous render), and for clips with no active
      // effect mask this falls through to the legacy `applyClipTransforms`
      // (idempotent) and still ends with `syncMaskSpriteTransform`.
      this.applyClipTransformsForClip(
        activeClip,
        logicalDimensions,
        clipVisualTimeTicks,
        this.getCurrentContentSizeOverride(activeClip.id),
      );
    }
  }

  private async renderSynchronizedPlaybackFrameInternal(
    trackClips: TimelineClip[],
    assets: Asset[],
    logicalDimensions: { width: number; height: number },
    request: {
      activeClip: TimelineClip;
      effectiveTick: number;
      fps: number;
      generation: number;
      maskClips: MaskTimelineClip[];
      clipVisualTimeTicks: number;
    },
  ): Promise<void> {
    const {
      activeClip,
      effectiveTick,
      fps,
      generation,
      maskClips,
      clipVisualTimeTicks,
    } = request;
    const textRenderableClip = getTextRenderableClip(activeClip);
    if (textRenderableClip) {
      const assetById = new Map<string, Asset>(
        assets.map((asset) => [asset.id, asset] as const),
      );
      const sourceFrame = this.setSynchronizedSourceFrameIntent(
        this.createSynchronizedSourceFrameRef(
          activeClip,
          null,
          effectiveTick,
          fps,
          generation,
        ),
      );
      this.latestMaskSyncContext = {
        maskClips,
        clip: textRenderableClip,
        logicalDimensions,
        rawTimeTicks: clipVisualTimeTicks,
        assetsById: assetById,
        sourceFrame,
        fps,
      };
      await this.renderTextClip(
        textRenderableClip,
        logicalDimensions,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      );
      return;
    }

    if (activeClip.type === "extension") {
      const assetById = new Map<string, Asset>(
        assets.map((asset) => [asset.id, asset] as const),
      );
      const sourceFrame = this.setSynchronizedSourceFrameIntent(
        this.createSynchronizedSourceFrameRef(
          activeClip,
          null,
          effectiveTick,
          fps,
          generation,
        ),
      );
      const rendered = await this.renderExtensionClip(
        activeClip,
        logicalDimensions,
        effectiveTick,
        clipVisualTimeTicks,
        maskClips,
        assetById,
        sourceFrame,
        fps,
      );
      if (!rendered) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        this.maskController.clear();
      }
      return;
    }

    if (!isDecoderRenderableClip(activeClip)) {
      this.invalidateLivePipeline();
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return;
    }

    for (
      let attempt = 0;
      attempt <= TrackRenderEngine.SYNCHRONIZED_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (generation !== this.synchronizedRenderGeneration) {
        return;
      }

      const nowMs = performance.now();
      const assetById = this.syncPreparedClips(
        effectiveTick,
        trackClips,
        assets,
        nowMs,
        false,
      );

      const asset = assetById.get(activeClip.assetId);
      const clipFps = asset?.fps && asset.fps > 0 ? asset.fps : fps;
      const sourceFrame = this.setSynchronizedSourceFrameIntent(
        createSourceFrameSyncRef({
          clip: activeClip,
          assetId: activeClip.assetId,
          effectiveTrackTick: effectiveTick,
          fps: clipFps,
          generation,
        }),
      );
      this.latestMaskSyncContext = {
        maskClips,
        clip: activeClip,
        logicalDimensions,
        rawTimeTicks: clipVisualTimeTicks,
        assetsById: assetById,
        sourceFrame,
        fps: clipFps,
      };

      this.invalidateLivePipeline();

      const shouldSend = this.shouldRequestFrame(
        activeClip,
        sourceFrame.frameIndex,
        sourceFrame.snappedTimeSeconds,
      );

      if (shouldSend) {
        this.lastRenderRequest = {
          time: sourceFrame.snappedTimeSeconds,
          clipId: activeClip.id,
          assetId: activeClip.assetId,
          frameIndex: sourceFrame.frameIndex,
        };

        try {
          const [frame] = await Promise.all([
            this.requestStrictLiveFrame(
              sourceFrame.snappedTimeSeconds,
              activeClip.id,
              clipVisualTimeTicks,
              { timeoutMs: TrackRenderEngine.LIVE_FRAME_TIMEOUT_MS },
            ),
            this.maskController.syncMaskClips(
              maskClips,
              activeClip,
              logicalDimensions,
              clipVisualTimeTicks,
              assetById,
              { fps: clipFps, sourceFrame, waitForSam2: true },
            ),
          ]);

          if (!this.isSynchronizedRenderCurrent(sourceFrame)) {
            if (frame.bitmap && typeof frame.bitmap.close === "function") {
              frame.bitmap.close();
            }
            return;
          }

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
                clipVisualTimeTicks,
                assetById,
                sourceFrame,
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

          if (isLiveFrameTimeoutError(error)) {
            if (!this.isSynchronizedRenderCurrent(sourceFrame)) {
              return;
            }

            this.lastRenderRequest = null;
            const shouldRecover = this.recordLiveDecoderTimeout();
            if (
              !shouldRecover ||
              attempt >= TrackRenderEngine.SYNCHRONIZED_RECOVERY_ATTEMPTS
            ) {
              return;
            }

            const resolution = await this.recoverStalledDecoder(
              activeClip.id,
              "synchronized playback timeout",
            );
            if (
              resolution !== "renderer-reset" &&
              resolution !== "worker-replaced"
            ) {
              return;
            }

            console.warn(
              "Live decoder worker stalled during synchronized playback; recovering decoder source",
              error,
            );
            await this.prepareClipForStrictRender(
              activeClip,
              assetById,
              performance.now(),
            );
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
            clipVisualTimeTicks,
            assetById,
            { fps: clipFps, sourceFrame, skipSam2FrameRender: true },
          );
        } catch (error) {
          console.warn("Failed to sync synchronized playback masks", error);
        }
      }

      if (this.sprite.visible && this.currentTextureClipId === activeClip.id) {
        this.applyClipTransformsForClip(
          activeClip,
          logicalDimensions,
          clipVisualTimeTicks,
        );
      }

      return;
    }
  }

  /**
   * Export-only: prepare the decoder sources for clips near `currentTime`
   * without running the live preview pipeline.
   *
   * The export loop produces every frame deterministically through
   * renderFrame(), which owns the strict mask + content renders. Driving the
   * live update() path here additionally fired a fire-and-forget *non-strict*
   * mask render that raced renderFrame()'s strict mask sync over shared
   * per-engine source-frame intent state — the strict reply was then judged
   * stale and dropped, hanging the export on the 5s strict-frame timeout (see
   * MaskVideoFramePlayer.handleLeaseFrame). The only thing export needs from
   * update() is the decoder-source prepare, so expose just that.
   */
  public prepareClipsForExportFrame(
    currentTime: number,
    trackClips: TimelineClip[],
    assets: Asset[],
  ): void {
    // Mirror update(): the prepare relevance/cleanup windows in
    // syncPreparedClips are measured against each clip's stored start/end, so
    // they must be keyed off the resolved effective tick — not raw
    // presentation time. Under ripple/static retiming a clip can be active at
    // presentation while its stored range sits outside the lookahead/cleanup
    // window, which would make export skip the prepare (or evict the source)
    // before renderFrame() requests the strict frame.
    const resolved = this.resolveActiveClipAtPresentation(
      trackClips,
      currentTime,
    );
    const effectiveTick = resolved?.effectiveTick ?? currentTime;
    this.syncPreparedClips(
      effectiveTick,
      trackClips,
      assets,
      performance.now(),
      false,
    );
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
    options: {
      fps?: number;
      signal?: AbortSignal;
      render?: FilterRenderContext;
    } = {},
  ): Promise<void> {
    this.invalidateLivePipeline();
    this.currentRenderContext = options.render ?? null;
    const effectiveTick = this.resolveEffectiveTrackTickForClip(
      activeClip,
      currentTime,
    );
    const { clipVisualTimeTicks } = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: currentTime,
      effectiveTrackTick: effectiveTick,
    });

    const textRenderableClip = getTextRenderableClip(activeClip);
    if (textRenderableClip) {
      const sourceFrame = this.advanceLiveSourceFrameIntent(
        createSourceFrameSyncRef({
          clip: activeClip,
          assetId: null,
          effectiveTrackTick: effectiveTick,
          fps: options.fps ?? 30,
          generation: this.liveRenderGeneration,
        }),
      );
      await this.renderTextClip(
        textRenderableClip,
        logicalDimensions,
        clipVisualTimeTicks,
        maskClips,
        assetsById,
        sourceFrame,
        options.fps,
      );
      return;
    }

    if (activeClip.type === "extension") {
      const sourceFrame = this.advanceLiveSourceFrameIntent(
        createSourceFrameSyncRef({
          clip: activeClip,
          assetId: null,
          effectiveTrackTick: effectiveTick,
          fps: options.fps ?? 30,
          generation: this.liveRenderGeneration,
        }),
      );
      const rendered = await this.renderExtensionClip(
        activeClip,
        logicalDimensions,
        currentTime,
        clipVisualTimeTicks,
        maskClips,
        assetsById,
        sourceFrame,
        options.fps ?? 30,
        true,
      );
      if (!rendered) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        this.maskController.clear();
      }
      return;
    }

    if (!isDecoderRenderableClip(activeClip)) {
      this.sprite.visible = false;
      this.currentTextureClipId = null;
      this.maskController.clear();
      return;
    }

    const asset = assetsById.get(activeClip.assetId);
    const clipFps =
      asset?.fps && asset.fps > 0 ? asset.fps : (options.fps ?? 30);

    const sourceFrame = this.advanceLiveSourceFrameIntent(
      createSourceFrameSyncRef({
        clip: activeClip,
        assetId: activeClip.assetId,
        effectiveTrackTick: effectiveTick,
        fps: clipFps,
        generation: this.liveRenderGeneration,
      }),
    );
    await this.maskController.syncMaskClips(
      maskClips,
      activeClip,
      logicalDimensions,
      clipVisualTimeTicks,
      assetsById,
      { fps: clipFps, sourceFrame, waitForSam2: true },
    );

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createRenderAbortError());
        return;
      }

      if (this.pendingReject) {
        this.rejectPendingFrame(
          new Error("Concurrent renderFrame() is not supported"),
        );
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
              clipVisualTimeTicks,
              {
                maskClips,
                assetsById,
                fps: clipFps,
                sourceFrame,
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

      this.lease.render({
        time: sourceFrame.snappedTimeSeconds,
        clipId: activeClip.id,
        transformTime: clipVisualTimeTicks,
        strict: true, // Export needs a response even if null
      });
    });
  }

  public cancelPendingFrame(error: Error = createRenderAbortError()) {
    this.rejectPendingFrame(error);
  }

  private handleLeaseFrame(message: {
    bitmap: ImageBitmap | null;
    clipId: string;
    transformTime?: number;
    error?: string;
    requestId?: string;
    reason?: string;
  }) {
    const { bitmap, clipId, transformTime, error, requestId } = message;
    this.markLiveDecoderResponsive();

    if (this.pendingResolve) {
      this.recordStrictFrameReply(message);
      this.pendingResolve(bitmap);
      return;
    }

    if (this.pendingLiveFrame) {
      const pendingLiveFrame = this.pendingLiveFrame;
      if (this.isStalePendingLiveFrameResponse(requestId, bitmap)) {
        return;
      }
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
      return;
    }

    if (bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }
  }

  private recordStrictFrameReply(message: {
    bitmap: ImageBitmap | null;
    clipId: string;
    error?: string;
    reason?: string;
  }): void {
    this.strictRenderHealth.replies += 1;
    if (!message.bitmap) {
      this.strictRenderHealth.nullFrames += 1;
    }
    if (message.reason === "missing-renderer") {
      this.strictRenderHealth.missingRendererFrames += 1;
    }
    if (message.error) {
      this.strictRenderHealth.errorFrames += 1;
    }

    const issue =
      message.reason === "missing-renderer"
        ? "no prepared decoder source (frame rendered blank)"
        : message.error
          ? `decode error: ${message.error}`
          : null;
    if (issue && !this.reportedStrictFrameIssueClipIds.has(message.clipId)) {
      this.reportedStrictFrameIssueClipIds.add(message.clipId);
      console.error(
        `[TrackRenderEngine] Strict render for clip ${message.clipId} returned ${issue}; further occurrences for this clip are counted silently`,
      );
    }
  }

  /**
   * Returns the strict-frame health tally accumulated since the last call and
   * resets it. Export pipelines call this once per run to detect renders that
   * silently produced blank frames.
   */
  public consumeStrictRenderHealth(): StrictRenderHealth {
    const health = this.strictRenderHealth;
    this.strictRenderHealth = createEmptyStrictRenderHealth();
    this.reportedStrictFrameIssueClipIds.clear();
    return health;
  }

  private handleLeaseWorkerError(error: Error): void {
    this.rejectPendingFrame(error);
    this.rejectPendingLiveFrame(error);
  }

  private handleDecoderSourceEvicted(clipId: string): void {
    this.preparedClips.delete(clipId);
    this.preparedClipTouchedAtMs.delete(clipId);
  }

  private enqueueLiveRenderRequest(request: LiveRenderRequest) {
    this.liveRenderQueue.push(request);
    this.pruneLiveRenderQueue(request.enqueuedAtMs);
    void this.runLiveRenderPipeline();
  }

  private postPrepareMessage(clip: TimelineClip, asset: Asset): void {
    const kind = getDecoderSourceKind(clip);
    if (!kind) {
      return;
    }

    const diagnostics = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "prepare",
      clipId: clip.id,
      label: this.trackId ?? undefined,
    });
    logDecoderRequestSent(diagnostics, {
      kind,
      hasFile: !!asset.file,
      fileSizeMB: asset.file
        ? Number((asset.file.size / (1024 * 1024)).toFixed(2))
        : null,
      sourceScheme: getSourceScheme(asset),
    });

    this.lease.prepare({
      url: asset.src,
      clipId: clip.id,
      kind,
      file: asset.file,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  private syncPreparedClips(
    currentTime: number,
    trackClips: TimelineClip[],
    assets: Asset[],
    nowMs: number,
    isLikelyScrubbing: boolean,
  ): Map<string, Asset> {
    // These windows are defined in seconds, then converted to ticks.
    const LOOKAHEAD_WINDOW_TICKS = mediaSecondsToTickExact(2.0);
    const CLEANUP_DELAY_TICKS = mediaSecondsToTickExact(
      isLikelyScrubbing ? 6.0 : 1.0,
    );
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
      if (isAssetBackedClip(clip) && storedAssetId === clip.assetId) {
        return;
      }

      if (storedAssetId !== undefined) {
        this.lease.disposeSource(clip.id);
        this.preparedClips.delete(clip.id);
        this.preparedClipTouchedAtMs.delete(clip.id);
      }

      if (!isDecoderRenderableClip(clip)) {
        return;
      }

      const asset = assetById.get(clip.assetId);
      if (!asset) {
        return;
      }

      const needsSourceHydration =
        asset.type === "video" && !hasEmbeddedAssetSource(asset);
      if (needsSourceHydration) {
        if (!this.pendingAssetHydrations.has(asset.id)) {
          this.pendingAssetHydrations.add(asset.id);
          const expectedClipId = clip.id;
          const expectedAssetId = clip.assetId;
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

              this.postPrepareMessage(clip, hydratedAsset);
              this.preparedClips.set(expectedClipId, expectedAssetId);
              this.preparedClipTouchedAtMs.set(
                expectedClipId,
                performance.now(),
              );
            })
            .finally(() => {
              this.pendingAssetHydrations.delete(asset.id);
            });
        }
        return;
      }

      this.postPrepareMessage(clip, asset);
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

      this.lease.disposeSource(clipId);
      this.preparedClips.delete(clipId);
      this.preparedClipTouchedAtMs.delete(clipId);
    }

    return assetById;
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
    const currentAssetId = isAssetBackedClip(activeClip)
      ? activeClip.assetId
      : null;
    return (
      !this.lastRenderRequest ||
      this.lastRenderRequest.frameIndex !== currentFrameIndex ||
      this.lastRenderRequest.clipId !== activeClip.id ||
      this.lastRenderRequest.assetId !== currentAssetId ||
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

        await this.renderLiveRenderRequestWithRecovery(request);
      }
    } finally {
      this.livePipelineBusy = false;
      if (this.liveRenderQueue.length > 0 && !this.disposed) {
        void this.runLiveRenderPipeline();
      }
    }
  }

  private async renderLiveRenderRequestWithRecovery(
    request: LiveRenderRequest,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= TrackRenderEngine.LIVE_RENDER_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (!this.isLiveRenderRequestCurrent(request)) {
        return;
      }

      try {
        const [frame] = await Promise.all([
          this.requestStrictLiveFrame(
            request.sourceFrame.snappedTimeSeconds,
            request.clip.id,
            request.sourceFrame.rawClipTick,
            { timeoutMs: TrackRenderEngine.LIVE_FRAME_TIMEOUT_MS },
          ),
          this.maskController.syncMaskClips(
            request.maskClips,
            request.clip,
            request.logicalDimensions,
            request.sourceFrame.rawClipTick,
            request.assetsById,
            {
              fps: request.sourceFrame.fps,
              sourceFrame: request.sourceFrame,
              waitForSam2: true,
            },
          ),
        ]);

        if (!this.isLiveRenderRequestCurrent(request)) {
          if (frame.bitmap && typeof frame.bitmap.close === "function") {
            frame.bitmap.close();
          }
          return;
        }

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
              request.sourceFrame.rawClipTick,
              request.assetsById,
              request.sourceFrame,
            );
          }
        }

        if (
          this.sprite.visible &&
          this.currentTextureClipId === request.clip.id
        ) {
          this.applyClipTransformsForClip(
            request.clip,
            request.logicalDimensions,
            request.sourceFrame.rawClipTick,
          );
        }

        if (this.onFrameReady) {
          this.onFrameReady(request.clip.id, request.sourceFrame.rawClipTick);
        }
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        if (isLiveFrameTimeoutError(error)) {
          if (!this.isLiveRenderRequestCurrent(request)) {
            return;
          }

          this.lastRenderRequest = null;
          const shouldRecover = this.recordLiveDecoderTimeout();
          if (
            !shouldRecover ||
            attempt >= TrackRenderEngine.LIVE_RENDER_RECOVERY_ATTEMPTS
          ) {
            return;
          }

          const resolution = await this.recoverStalledDecoder(
            request.clip.id,
            "live playback timeout",
          );
          if (
            resolution !== "renderer-reset" &&
            resolution !== "worker-replaced"
          ) {
            return;
          }

          console.warn(
            "Live decoder worker stalled during live playback; recovering decoder source",
            error,
          );
          await this.prepareClipForStrictRender(
            request.clip,
            request.assetsById,
            performance.now(),
          );
          continue;
        }

        console.warn("Failed to render synchronized live frame", error);
        return;
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
    const requestId = this.createLiveFrameRequestId();
    const diagnostics = createDecoderRequestDiagnostics({
      source: "track",
      requestType: "render",
      clipId,
      label: this.trackId ?? undefined,
    });

    return awaitStrictFrame<LiveFramePayload>({
      timeoutMs: options.timeoutMs,
      createTimeoutError: (timeoutMs) => {
        logDecoderRequestTimeout(diagnostics, {
          timeoutMs,
          time: localTimeSeconds,
          requestId,
        });
        return createLiveFrameTimeoutError(timeoutMs, clipId);
      },
      registerPending: (pending) => {
        this.pendingLiveFrame = pending;
        this.pendingLiveFrameRequestId = requestId;
      },
      unregisterPending: (pending) => {
        if (this.pendingLiveFrame === pending) {
          this.pendingLiveFrame = null;
          this.pendingLiveFrameRequestId = null;
        }
      },
      onExternalReject: (error) => {
        logDecoderRequestAborted(diagnostics, {
          reason: error.name,
          message: error.message,
          time: localTimeSeconds,
          requestId,
        });
      },
      sendRequest: () => {
        logDecoderRequestSent(diagnostics, {
          time: localTimeSeconds,
          transformTime,
          strict: true,
          requestId,
          timeoutMs: options.timeoutMs,
        });
        this.lease.render({
          time: localTimeSeconds,
          clipId,
          transformTime,
          strict: true,
          requestId,
          ...(diagnostics ? { diagnostics } : {}),
        });
      },
    });
  }

  private createLiveFrameRequestId(): string {
    this.nextLiveFrameRequestId += 1;
    return `live-frame-${this.nextLiveFrameRequestId}`;
  }

  private createLiveRenderGeneration(): number {
    this.liveRenderGeneration += 1;
    return this.liveRenderGeneration;
  }

  private createSynchronizedRenderGeneration(): number {
    this.synchronizedRenderGeneration += 1;
    return this.synchronizedRenderGeneration;
  }

  private createLiveSourceFrameRef(
    clip: TimelineClip,
    assetId: string | null,
    effectiveTrackTick: number,
    fps: number,
  ): SourceFrameSyncRef {
    return createSourceFrameSyncRef({
      clip,
      assetId,
      effectiveTrackTick,
      fps,
      generation: this.liveRenderGeneration,
    });
  }

  private advanceLiveSourceFrameIntent(
    sourceFrame: SourceFrameSyncRef,
  ): SourceFrameSyncRef {
    if (this.currentLiveSourceFrameIntent?.key !== sourceFrame.key) {
      sourceFrame = {
        ...sourceFrame,
        generation: this.createLiveRenderGeneration(),
      };
    }
    this.currentLiveSourceFrameIntent = {
      generation: sourceFrame.generation,
      key: sourceFrame.key,
    };
    return sourceFrame;
  }

  private createSynchronizedSourceFrameRef(
    clip: TimelineClip,
    assetId: string | null,
    effectiveTrackTick: number,
    fps: number,
    generation: number,
  ): SourceFrameSyncRef {
    return createSourceFrameSyncRef({
      clip,
      assetId,
      effectiveTrackTick,
      fps,
      generation,
    });
  }

  private setSynchronizedSourceFrameIntent(
    sourceFrame: SourceFrameSyncRef,
  ): SourceFrameSyncRef {
    this.currentSynchronizedSourceFrameIntent = {
      generation: sourceFrame.generation,
      key: sourceFrame.key,
    };
    return sourceFrame;
  }

  private isLiveRenderRequestCurrent(request: LiveRenderRequest): boolean {
    return isSourceFrameIntentCurrent(this.currentLiveSourceFrameIntent, {
      generation: request.sourceFrame.generation,
      key: request.sourceFrame.key,
    });
  }

  private isSynchronizedRenderCurrent(
    sourceFrame: SourceFrameSyncRef,
  ): boolean {
    return isSourceFrameIntentCurrent(this.currentSynchronizedSourceFrameIntent, {
      generation: sourceFrame.generation,
      key: sourceFrame.key,
    });
  }

  private recordLiveDecoderTimeout(): boolean {
    this.liveDecoderTimeoutCount += 1;
    return (
      this.liveDecoderTimeoutCount >=
      TrackRenderEngine.LIVE_DECODER_RESET_TIMEOUTS
    );
  }

  private markLiveDecoderResponsive(): void {
    this.liveDecoderTimeoutCount = 0;
  }

  private isStalePendingLiveFrameResponse(
    requestId: unknown,
    bitmap: ImageBitmap | null,
  ): boolean {
    const expectedRequestId = this.pendingLiveFrameRequestId;
    if (
      !expectedRequestId ||
      typeof requestId !== "string" ||
      requestId === expectedRequestId
    ) {
      return false;
    }

    if (bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }
    return true;
  }

  private async prepareClipForStrictRender(
    clip: TimelineClip,
    assetsById: Map<string, Asset>,
    nowMs: number,
  ): Promise<void> {
    if (!isDecoderRenderableClip(clip)) {
      return;
    }

    const asset = assetsById.get(clip.assetId);
    if (!asset) {
      return;
    }
    if (this.preparedClips.get(clip.id) === clip.assetId) {
      return;
    }

    let sourceAsset = asset;
    if (asset.type === "video" && !hasEmbeddedAssetSource(asset)) {
      const hydratedAsset = await ensureAssetSourceLoaded(asset.id);
      if (!hydratedAsset) {
        return;
      }
      sourceAsset = hydratedAsset;
    }

    if (this.disposed) {
      return;
    }
    if (this.preparedClips.get(clip.id) === clip.assetId) {
      return;
    }

    this.postPrepareMessage(clip, sourceAsset);
    this.preparedClips.set(clip.id, clip.assetId);
    this.preparedClipTouchedAtMs.set(clip.id, nowMs);
  }

  private invalidateLivePipeline() {
    this.liveRenderGeneration += 1;
    this.currentLiveSourceFrameIntent = null;
    this.liveRenderQueue.length = 0;
    this.rejectPendingLiveFrame(createRenderAbortError());
  }

  private async recoverStalledDecoder(
    clipId: string,
    reason: string,
  ): Promise<DecoderStallResolution> {
    this.rejectPendingLiveFrame(createRenderAbortError());
    this.liveRenderQueue.length = 0;
    this.lastRenderRequest = null;
    const resolution = await this.lease.reportStall(clipId, reason);
    if (
      resolution === "renderer-reset" ||
      resolution === "worker-replaced"
    ) {
      this.preparedClips.delete(clipId);
      this.preparedClipTouchedAtMs.delete(clipId);
      this.liveDecoderTimeoutCount = 0;
    }
    return resolution;
  }

  private pruneLiveRenderQueue(nowMs: number) {
    while (
      this.liveRenderQueue.length > 1 &&
      nowMs - this.liveRenderQueue[0].enqueuedAtMs >
        TrackRenderEngine.MAX_LIVE_REQUEST_AGE_MS
    ) {
      this.liveRenderQueue.shift();
    }

    if (
      this.liveRenderQueue.length <= TrackRenderEngine.MAX_LIVE_RENDER_QUEUE
    ) {
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
      sourceFrame?: SourceFrameSyncRef;
      fps?: number;
    } = {},
  ) {
    if (bitmap) {
      const texture = Texture.from(bitmap);
      const contentSizeChanged = this.applyTexture(texture, clip.id, "asset");
      // When the resolved content size changed, re-sync masks at the new size
      // BEFORE applying transforms, so the offscreen effect-mask chain
      // composites against correctly-sized, current coverage rather than the
      // pre-decode sync's (wrong-sized) coverage with no later recomposite.
      // Mirrors the live render paths (renderLiveRenderRequestWithRecovery /
      // renderSynchronizedPlaybackFrameInternal): sync/resync → then transform.
      if (contentSizeChanged) {
        await this.resyncMasksForResolvedTexture(
          options.maskClips ?? [],
          clip,
          dimensions,
          rawTime,
          options.assetsById ?? new Map<string, Asset>(),
          options.sourceFrame,
          options.fps,
        );
      }
      this.applyClipTransformsForClip(clip, dimensions, rawTime);
    }
  }

  private applyTexture(
    texture: Texture,
    clipId: string,
    sourceKind: "asset" | "text" | "extension",
    sharedHandle: SharedTextureHandle | null = null,
  ): boolean {
    if (sourceKind !== "extension") {
      this.extensionEntityRenderer?.invalidateTextureCache();
    }
    // Size comparison uses the displayed texture (in offscreen effect mode that
    // is a pool effect output, which is content-sized like the source, so the
    // result is equivalent to comparing sources).
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

    // Retire the previously applied SOURCE, not `sprite.texture`: a displayed
    // effect output is pool-owned and must never be retired here (it is simply
    // dereferenced when the source is reassigned below).
    const previousSource = this.effectSourceTexture;
    const previousSharedHandle = this.currentSharedTextureHandle;
    this.sprite.texture = texture;
    this.effectSourceTexture = texture;
    this.currentSharedTextureHandle = sharedHandle;
    if (previousSource && previousSource !== texture) {
      if (
        previousSharedHandle &&
        previousSharedHandle.texture === previousSource
      ) {
        previousSharedHandle.release();
      } else {
        this.retiredTextures.retire(previousSource);
      }
    } else if (
      previousSharedHandle &&
      previousSharedHandle !== sharedHandle
    ) {
      previousSharedHandle.release();
    }
    this.sprite.visible = true;
    this.currentTextureClipId = clipId;
    this.currentTextureSourceKind = sourceKind;
    return contentSizeChanged;
  }

  /** Render-sample identity for this frame's clip render (see the field docs). */
  private buildFrameRenderContext(rawTime: number) {
    return (
      this.currentRenderContext ??
      createFrameFilterRenderContext(
        rawTime,
        this.currentRenderFps,
        this.currentRenderMode,
      )
    );
  }

  private applyClipTransformsForClip(
    clip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    contentSizeOverride?: { width: number; height: number },
  ) {
    if (
      !this.tryApplyOffscreenEffectMask(
        clip,
        logicalDimensions,
        rawTime,
        contentSizeOverride,
      )
    ) {
      // Leaving the offscreen effect-mask path ends ownership of its retained
      // filter slots. A later masked render must not inherit stale history.
      this.maskedEffectRenderer?.reset();
      this.effectMaskTemporalBranch.reset();
      applyClipTransforms(
        this.sprite,
        clip,
        logicalDimensions,
        rawTime,
        resolveClipTransformContentSize(
          clip,
          logicalDimensions,
          contentSizeOverride,
        ),
        {
          mapContentSizeToTexture: contentSizeOverride != null,
          render: this.buildFrameRenderContext(rawTime),
        },
      );
    }
    this.maskController.syncMaskSpriteTransform();
  }

  private setCurrentContentSizeOverride(
    clipId: string,
    contentSize: { width: number; height: number } | null,
  ): void {
    this.currentContentSizeOverride = contentSize
      ? { clipId, size: { ...contentSize } }
      : null;
    this.maskController.setActiveClipContentSizeOverride(contentSize);
  }

  private getCurrentContentSizeOverride(
    clipId: string,
  ): { width: number; height: number } | undefined {
    return this.currentContentSizeOverride?.clipId === clipId
      ? this.currentContentSizeOverride.size
      : undefined;
  }

  /**
   * Effect-level masking: when any enabled filter carries an active effect
   * mask, render the filter chain offscreen from the unfiltered source and show
   * the result, instead of applying the filters to `sprite.filters`. Returns
   * false (caller falls back to the normal path) when there's no renderer, no
   * source, or no effect mask is active.
   *
   * Requires this frame's masks to be synced first (for coverage); where they
   * aren't, `resolveEffectMaskCoverage` returns null and the masked step simply
   * contributes nothing — never a whole-clip effect or corruption.
   */
  private tryApplyOffscreenEffectMask(
    clip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    contentSizeOverride?: { width: number; height: number },
  ): boolean {
    const renderer = this.maskedEffectRenderer;
    const source = this.effectSourceTexture;
    if (
      !renderer ||
      !source ||
      source === Texture.EMPTY ||
      !(source.width > 0 && source.height > 0)
    ) {
      return false;
    }

    const plan = planTransformRender(clip.transformations);
    if (plan.mode !== "offscreen") {
      // An enabled effect mask that produced no offscreen plan means the filter
      // wasn't recognized — surface it under debug mode rather than silently
      // falling back to no effect.
      if (
        useDebugStore.getState().debugMode &&
        clip.transformations?.some((t) => t.effectMask?.enabled)
      ) {
        console.warn(
          "[effect-mask] enabled effect mask did not yield an offscreen plan",
          { clip: clip.id, types: clip.transformations?.map((t) => t.type) },
        );
      }
      return false;
    }

    const contentSize = resolveClipTransformContentSize(
      clip,
      logicalDimensions,
      contentSizeOverride,
      { width: source.width, height: source.height },
    )!;
    const stackTime = rawTime + (clip.transformedOffset || 0);
    const { lookup: filterOpLookup, sourceTimeTicks } =
      buildResolvedFilterOpLookupWithTime(
        clip.transformations,
        {
          container: logicalDimensions,
          content: contentSize,
          visualTime: rawTime,
          visualDuration: clip.timelineDuration,
        },
        stackTime,
      );

    const baseRender = {
      ...this.buildFrameRenderContext(rawTime),
      visualTimeTicks: rawTime,
      sourceTimeTicks,
    };
    const availabilityByExpression = new Map<string, boolean>();
    const coverageByExpression = new Map<string, Texture | null>();
    for (const step of plan.steps) {
      if (step.resolution.kind !== "masked") continue;
      const expressionKey = JSON.stringify(step.resolution.expression);
      if (!availabilityByExpression.has(expressionKey)) {
        availabilityByExpression.set(
          expressionKey,
          this.maskController.canResolveEffectMaskCoverage(
            step.resolution.expression,
            contentSize,
          ),
        );
      }
    }
    const availabilityKey = plan.steps
      .map((step) => {
        if (step.resolution.kind !== "masked") return step.resolution.kind;
        const expressionKey = JSON.stringify(step.resolution.expression);
        return availabilityByExpression.get(expressionKey)
          ? `masked:${expressionKey}`
          : `unavailable:${expressionKey}`;
      })
      .join("|");
    const render = this.effectMaskTemporalBranch.map(
      baseRender,
      availabilityKey,
    );
    const output = renderer.render({
      input: source,
      steps: plan.steps,
      contentSize,
      render,
      cacheKey: this.buildEffectMaskCacheKey(
        source,
        contentSize,
        plan.steps,
        filterOpLookup,
        render,
      ),
      resolveFilterOp: (transform) => filterOpLookup.get(transform),
      resolveCoverage: (expression) => {
        const expressionKey = JSON.stringify(expression);
        if (!availabilityByExpression.get(expressionKey)) return null;
        if (!coverageByExpression.has(expressionKey)) {
          coverageByExpression.set(
            expressionKey,
            this.maskController.resolveEffectMaskCoverage(
              expression,
              contentSize,
            ),
          );
        }
        const coverage = coverageByExpression.get(expressionKey) ?? null;
        // A masked filter with no coverage contributes nothing (no whole-clip
        // effect); surface that under debug mode so a missing/inactive mask is
        // diagnosable rather than silent.
        if (!coverage && useDebugStore.getState().debugMode) {
          console.warn("[effect-mask] no coverage for masked filter", {
            clip: clip.id,
            expression,
          });
        }
        return coverage;
      },
    });

    this.sprite.texture = output;
    // Layout + range-mask still apply to the sprite; the filter chain is baked
    // into `output`, so suppress the transform filters here.
    applyClipTransforms(
      this.sprite,
      clip,
      logicalDimensions,
      rawTime,
      contentSize,
      {
        applyFilterTransforms: false,
        mapContentSizeToTexture: contentSizeOverride != null,
        render,
      },
    );
    return true;
  }

  /**
   * Identity of everything the offscreen effect-mask render depends on, so an
   * unchanged paused frame reuses the previous output instead of re-running the
   * filter + composite GPU passes (mirrors `MaskBooleanTextureRenderer`'s
   * cache-key approach). Captures:
   *  - the source frame (`Texture.uid`) and content size,
   *  - the mask scene state (`getMaskSyncEpoch` — bumps on any mask change so
   *    edited/arriving coverage invalidates even with stable filter params),
   *  - per step: the transform id, its resolution (incl. masked expression),
   *    and the resolved, time-sampled filter op (so a blur-strength edit, which
   *    changes the op params, invalidates).
   */
  private buildEffectMaskCacheKey(
    source: Texture,
    contentSize: { width: number; height: number },
    steps: readonly FilterRenderStep[],
    filterOpLookup: Map<ClipTransform, ResolvedFilterOp>,
    render: FilterRenderContext,
  ): string {
    const parts: string[] = [
      `src:${source.uid}`,
      `size:${contentSize.width}x${contentSize.height}`,
      `mask:${this.maskController.getMaskSyncEpoch()}`,
    ];
    for (const step of steps) {
      const op = filterOpLookup.get(step.transform);
      const opKey = op ? `${op.type}:${JSON.stringify(op.params)}` : "none";
      const resKey =
        step.resolution.kind === "masked"
          ? `masked:${JSON.stringify(step.resolution.expression)}`
          : step.resolution.kind;
      parts.push(`${step.transform.id}|${resKey}|${opKey}`);
    }
    const sampleIdentity = getTemporalSampleCacheIdentity(
      steps.map((step) => step.transform),
      render,
    );
    if (sampleIdentity) {
      parts.push(sampleIdentity);
    }
    return parts.join("::");
  }

  private async renderExtensionClip(
    clip: ExtensionTimelineClip,
    logicalDimensions: { width: number; height: number },
    presentationTimeTicks: number,
    rawTime: number,
    maskClips: MaskTimelineClip[],
    assetsById: Map<string, Asset>,
    sourceFrame: SourceFrameSyncRef,
    fps: number,
    waitForAssetMasks: boolean = false,
  ): Promise<boolean> {
    if (
      extensionEntityProviderRegistry.getAvailability(clip.extensionPayload) !==
      "available"
    ) {
      return false;
    }

    const entityRenderer = this.extensionEntityRenderer;
    const result = entityRenderer?.render({
      clip,
      logicalDimensions,
      presentationTimeTicks,
      visualTimeTicks: rawTime,
      sourceTimeTicks: sourceFrame.sourceTimeTicks,
      fps,
      assetsById,
    });
    if (!result?.ok) {
      console.warn(
        `Failed to render extension entity ${clip.extensionPayload.extensionId}/${clip.extensionPayload.typeId}`,
        result?.error ?? new Error("A Pixi renderer is not available."),
      );
      await this.renderTextClip(
        createExtensionPlaceholderClip(clip, "Extension renderer failed"),
        logicalDimensions,
        rawTime,
        maskClips,
        assetsById,
        sourceFrame,
        fps,
      );
      return true;
    }

    this.applyTexture(result.texture, clip.id, "extension");
    try {
      await this.maskController.syncMaskClips(
        maskClips,
        clip,
        logicalDimensions,
        rawTime,
        assetsById,
        waitForAssetMasks
          ? { fps, sourceFrame, waitForSam2: true }
          : { fps, sourceFrame, skipSam2FrameRender: true },
      );
    } catch (error) {
      console.warn("Failed to sync extension entity masks", error);
    }
    this.applyClipTransformsForClip(clip, logicalDimensions, rawTime);
    return true;
  }

  private async renderTextClip(
    clip: TextTimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    maskClips: MaskTimelineClip[],
    assetsById: Map<string, Asset>,
    sourceFrame: SourceFrameSyncRef,
    fps?: number,
  ): Promise<void> {
    const nextSignature = getTextTextureSignature(
      clip,
      this.renderer,
      logicalDimensions,
    );
    const hasReusableTextTexture =
      this.currentTextureSourceKind === "text" &&
      this.currentTextTextureSignature === nextSignature &&
      this.sprite.texture !== Texture.EMPTY;

    if (hasReusableTextTexture) {
      this.sprite.visible = true;
      this.currentTextureClipId = clip.id;
    } else {
      const texture = await createTextTexture(
        clip,
        this.renderer,
        logicalDimensions,
      );
      if (!texture) {
        this.sprite.visible = false;
        this.currentTextureClipId = null;
        return;
      }

      this.applyTexture(texture, clip.id, "text");
      this.currentTextTextureSignature = nextSignature;
    }

    // Sync masks BEFORE applying transforms so the offscreen effect-mask chain
    // resolves coverage from this frame's mask set (not the previous frame's,
    // or null on the first render) — the same ordering the asset/live paths use.
    try {
      await this.maskController.syncMaskClips(
        maskClips,
        clip,
        logicalDimensions,
        rawTime,
        assetsById,
        { fps, sourceFrame, skipSam2FrameRender: true },
      );
    } catch (error) {
      console.warn("Failed to sync text clip masks", error);
    }

    this.applyClipTransformsForClip(clip, logicalDimensions, rawTime);
  }

  private async resyncMasksForResolvedTexture(
    maskClips: MaskTimelineClip[],
    clip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
    assetsById: Map<string, Asset>,
    sourceFrame?: SourceFrameSyncRef,
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
        { fps, sourceFrame, skipSam2FrameRender: true },
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
        {
          fps: context.fps,
          sourceFrame: context.sourceFrame,
          skipSam2FrameRender: true,
        },
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
   * Apply transient transform values directly to the resident Pixi scene.
   *
   * This path deliberately does not resolve a source frame or reconcile mask
   * structure. Callers can queue {@link refreshLiveMaskPresentation} when the
   * returned mask state says the resting presentation uses a coverage texture.
   */
  public applyLiveTransformUpdates(
    activeClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    currentTime: number,
    maskClips: MaskTimelineClip[] = [],
    options: {
      updateClipTransforms?: boolean;
      maskClipIds?: ReadonlySet<string>;
    } = {},
  ): {
    didUpdateMaskTransforms: boolean;
    needsMaskPresentationRefresh: boolean;
    needsEffectPresentationRefresh: boolean;
  } {
    if (!this.sprite.visible) {
      return {
        didUpdateMaskTransforms: false,
        needsMaskPresentationRefresh: false,
        needsEffectPresentationRefresh: false,
      };
    }
    const { clipVisualTimeTicks } = resolveClipRenderTime({
      clip: activeClip,
      presentationTick: currentTime,
      resolveEffectiveTrackTick: (targetClip, tick) =>
        this.resolveEffectiveTrackTickForClip(targetClip, tick),
    });

    if (options.updateClipTransforms) {
      this.applyClipTransformsForClip(
        activeClip,
        logicalDimensions,
        clipVisualTimeTicks,
        this.getCurrentContentSizeOverride(activeClip.id),
      );
    }

    const maskUpdate =
      options.maskClipIds && options.maskClipIds.size > 0
        ? this.maskController.syncLiveMaskTransforms(
            maskClips,
            activeClip,
            logicalDimensions,
            clipVisualTimeTicks,
            options.maskClipIds,
          )
        : null;

    return {
      didUpdateMaskTransforms: maskUpdate?.didUpdate ?? false,
      needsMaskPresentationRefresh:
        maskUpdate?.needsSpatialPresentationRefresh ?? false,
      needsEffectPresentationRefresh:
        maskUpdate?.needsEffectPresentationRefresh ?? false,
    };
  }

  /**
   * Refresh mask-dependent GPU output after live node transforms have moved.
   * Called from the high-priority Pixi live-update scheduler, immediately
   * before the Application's own stage render.
   */
  public refreshLiveMaskPresentation(
    activeClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    currentTime: number,
    refreshEffectPresentation: boolean,
  ): void {
    if (!this.sprite.visible) {
      return;
    }

    this.maskController.refreshLiveMaskPresentation();
    if (!refreshEffectPresentation) {
      return;
    }

    const { clipVisualTimeTicks } = resolveClipRenderTime({
      clip: activeClip,
      presentationTick: currentTime,
      resolveEffectiveTrackTick: (targetClip, tick) =>
        this.resolveEffectiveTrackTickForClip(targetClip, tick),
    });
    this.applyClipTransformsForClip(
      activeClip,
      logicalDimensions,
      clipVisualTimeTicks,
      this.getCurrentContentSizeOverride(activeClip.id),
    );
  }

  /**
   * Reapply the latest authored transforms after an asynchronous decoder frame
   * arrives. The engine retains the frame's logical content boundary so this
   * refresh cannot downgrade a composite to ordinary physical-texture layout.
   */
  public refreshClipTransformsAtRawTime(
    activeClip: TimelineClip,
    logicalDimensions: { width: number; height: number },
    rawTime: number,
  ): void {
    if (
      !this.sprite.visible ||
      this.currentTextureClipId !== activeClip.id
    ) {
      return;
    }
    this.applyClipTransformsForClip(
      activeClip,
      logicalDimensions,
      rawTime,
      this.getCurrentContentSizeOverride(activeClip.id),
    );
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
  ): void {
    if (!this.sprite.visible) return;
    const effectiveTick = this.resolveEffectiveTrackTickForClip(
      activeClip,
      currentTime,
    );
    const { clipVisualTimeTicks } = resolveClipRenderTimeFromEffectiveTick({
      clip: activeClip,
      presentationTick: currentTime,
      effectiveTrackTick: effectiveTick,
    });
    const fallbackFps = this.latestMaskSyncContext?.fps ?? 30;
    const sourceFrame = this.advanceLiveSourceFrameIntent(
      createSourceFrameSyncRef({
        clip: activeClip,
        assetId: isAssetBackedClip(activeClip) ? activeClip.assetId : null,
        effectiveTrackTick: effectiveTick,
        fps: fallbackFps,
        generation: this.liveRenderGeneration,
      }),
    );
    this.applyClipTransformsForClip(
      activeClip,
      logicalDimensions,
      clipVisualTimeTicks,
      this.getCurrentContentSizeOverride(activeClip.id),
    );
    void this.maskController
      .syncMaskClips(
        maskClips,
        activeClip,
        logicalDimensions,
        clipVisualTimeTicks,
        assetsById,
        { sourceFrame, skipSam2FrameRender: true },
      )
      .then(() => {
        this.applyClipTransformsForClip(
          activeClip,
          logicalDimensions,
          clipVisualTimeTicks,
          this.getCurrentContentSizeOverride(activeClip.id),
        );
      })
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
    const sourceTexture = this.effectSourceTexture;
    const sharedTextureHandle = this.currentSharedTextureHandle;
    this.currentSharedTextureHandle = null;
    this.effectSourceTexture = null;
    this.sprite.texture = Texture.EMPTY;
    if (!sharedTextureHandle || currentTexture !== sharedTextureHandle.texture) {
      destroyTexture(currentTexture);
    }
    // The displayed texture may be a pool-owned effect output; destroying it
    // first is harmless (destroyTexture is idempotent) and the pool dispose
    // below frees the rest. The retained source is engine-owned — free it too.
    if (
      sourceTexture &&
      sourceTexture !== currentTexture &&
      (!sharedTextureHandle || sourceTexture !== sharedTextureHandle.texture)
    ) {
      destroyTexture(sourceTexture);
    }
    sharedTextureHandle?.release();
    this.retiredTextures.flush();

    releaseTransformationFilters(this.sprite);
    this.maskedEffectRenderer?.dispose();
    this.extensionEntityRenderer?.dispose();
    this.maskController.dispose();
    this.lease.release();
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
    const frameTicks = ticksPerFrame(Math.max(1, fps));
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
    this.pendingLiveFrameRequestId = null;
    rejectPending(error);
  }
}
