import { Application, Container, RenderTexture } from "pixi.js";
import { enableAdvancedBlendModes } from "../../../core/pixi/advancedBlendModes";
import type {
  TimelineTrack,
  TimelineClip,
  MaskTimelineClip,
  TimelineSelection,
} from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import { computeFurthestPresentationEnd } from "../../timeline/utils/clipPresentation";
import {
  frameIndexToOutputTimestamp,
  mediaSecondsToTickExact,
  tickToMediaSeconds,
} from "../utils/mediaTime";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import { RenderGroupOrchestrator } from "./RenderGroupOrchestrator";
import {
  TrackRenderEngine,
  createEmptyStrictRenderHealth,
  isBlankStrictRenderHealth,
  type StrictRenderHealth,
} from "./TrackRenderEngine";
import { TrackAudioRenderer } from "./TrackAudioRenderer";
import { createDecoderWorkerPool } from "./DecoderWorkerPool";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import { getAssetInput } from "../../userAssets";
import {
  getIncludedClipsForSelection,
  getIncludedTracksForSelection,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../../timelineSelection";
import {
  TextureOutputEncoder,
  type OutputVideoAnalysis,
  type OutputVideoDefinition,
} from "./TextureOutputEncoder";
import {
  BatchFrameGraphExecutor,
  FrameJobResolver,
  buildFrameResolutionGraph,
  buildScenePresentationPlan,
  type FrameJobResolutionTrack,
} from "./framePlanning";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

function resolveOutputDefinitions(
  options: RenderOptions,
): OutputVideoDefinition[] {
  const fallbackFormat = options.format ?? "mp4";

  function ensureUniqueIds(definitions: OutputVideoDefinition[]) {
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (!definition.id || !definition.id.trim()) {
        throw new Error("Every render output must include a non-empty id");
      }
      if (seen.has(definition.id)) {
        throw new Error(`Duplicate render output id '${definition.id}'`);
      }
      seen.add(definition.id);
    }
  }

  if (options.outputs && options.outputs.length > 0) {
    const definitions = options.outputs.map((definition, index) => {
      return {
        ...definition,
        includeAudio: definition.includeAudio ?? index === 0,
      };
    });
    ensureUniqueIds(definitions);
    return definitions;
  }

  const defaults: OutputVideoDefinition[] = [
    {
      id: "video",
      format: fallbackFormat,
      includeAudio: true,
    },
  ];

  ensureUniqueIds(defaults);
  return defaults;
}

interface PreparedVisualRenderData {
  trackClipsByTrackId: Map<string, TimelineClip[]>;
  maskClipsByParent: Map<string, MaskTimelineClip[]>;
  visualTracks: TimelineTrack[];
}

function buildVisualRenderData(
  tracks: TimelineTrack[],
  rawSelectedClips: TimelineClip[],
  includeTimelineMasks: boolean,
): PreparedVisualRenderData {
  const selectedClips = rawSelectedClips;

  // When timeline masks are excluded, also strip range_mask components.
  // Spatial masks (mask_ref) and range masks both contribute timeline-driven
  // transparency to the source output; range masks are applied via an
  // AlphaFilter in applyClipTransforms, which doesn't otherwise see this flag.
  const effectiveClips: TimelineClip[] = includeTimelineMasks
    ? selectedClips
    : selectedClips.map((clip) => {
        if (
          clip.type === "mask" ||
          !clip.components?.some((c) => c.type === "range_mask")
        ) {
          return clip;
        }
        return {
          ...clip,
          components: clip.components.filter((c) => c.type !== "range_mask"),
        };
      });

  const trackClipsByTrackId = new Map(
    tracks.map((track) => [
      track.id,
      sortTrackClipsByStart(
        effectiveClips.filter(
          (clip) => clip.trackId === track.id && clip.type !== "mask",
        ),
      ),
    ]),
  );

  const maskClipsByParent = new Map<string, MaskTimelineClip[]>();
  if (includeTimelineMasks) {
    const clipsById = new Map(
      selectedClips.map((clip) => [clip.id, clip] as const),
    );
    for (const clip of selectedClips) {
      if (clip.type === "mask") continue;
      const maskChildIds = (clip.components ?? [])
        .filter((component) => component.type === "mask_ref")
        .map((component) => component.parameters.maskClipId);
      if (maskChildIds.length === 0) continue;

      const masks: MaskTimelineClip[] = [];
      for (const maskChildId of maskChildIds) {
        const child = clipsById.get(maskChildId);
        if (child && child.type === "mask") {
          masks.push(child as MaskTimelineClip);
        }
      }

      if (masks.length > 0) {
        maskClipsByParent.set(clip.id, masks);
      }
    }
  }

  const visualTracks = tracks.filter(
    (track) => track.type === "visual" && track.isVisible,
  );

  return {
    trackClipsByTrackId,
    maskClipsByParent,
    visualTracks,
  };
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/png" | "image/webp",
  quality?: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Failed to encode canvas as ${mimeType}`));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

export interface ExportConfig {
  logicalWidth: number;
  logicalHeight: number;
  outputWidth: number;
  outputHeight: number;
  backgroundAlpha?: number;
  fileHandle?: FileSystemFileHandle;
}

export interface ProjectData {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  assets: Asset[];
  duration: number;
  fps: number;
}

export interface RenderOptions {
  timelineSelection?: TimelineSelection;
  format?: "mp4";
  outputs?: OutputVideoDefinition[];
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
}

export interface RenderStillOptions {
  timelineSelection?: TimelineSelection;
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
  mimeType?: "image/png" | "image/webp";
  quality?: number;
}

export interface RenderResult {
  video: Blob;
  mask?: Blob;
  outputs: Record<string, Blob>;
  outputAnalyses?: Record<string, OutputVideoAnalysis>;
  renderHealth?: ExportRenderHealth;
}

export interface ExportRenderHealth {
  totals: StrictRenderHealth;
  byTrack: Record<string, StrictRenderHealth>;
}

export { isBlankStrictRenderHealth } from "./TrackRenderEngine";

export class ExportRenderer {
  private app: Application;
  private logicalStage: Container;
  private engines: TrackRenderEngine[] = [];
  private orchestrator: RenderGroupOrchestrator | null = null;
  private cancelController: AbortController | null = null;
  private isCancelled = false;

  private constructor(app: Application, logicalStage: Container) {
    this.app = app;
    this.logicalStage = logicalStage;
  }

  /**
   * Factory method to create an initialized ExportRenderer
   */
  public static async create(config: ExportConfig): Promise<ExportRenderer> {
    const {
      logicalHeight,
      outputWidth,
      outputHeight,
      backgroundAlpha = 1,
    } = config;

    // 1. Initialize Headless App (Physical Resolution)
    // Register advanced blend modes so exported clip blend modes match preview.
    enableAdvancedBlendModes();
    const app = new Application();

    await app.init({
      width: outputWidth,
      height: outputHeight,
      backgroundColor: 0x000000,
      backgroundAlpha,
      antialias: true,
      resolution: 1,
      autoDensity: false,
      // Advanced blend modes read from the back buffer on WebGL.
      useBackBuffer: true,
    });

    // 2. Setup the "Logical Stage"
    const logicalStage = new Container();

    // Calculate Scale Factor (Uniform scaling to fit height)
    const scale = outputHeight / logicalHeight;

    logicalStage.scale.set(scale);
    app.stage.addChild(logicalStage);

    return new ExportRenderer(app, logicalStage);
  }

  /**
   * Renders the project frame-by-frame and exports one or more video files.
   * Outputs are configurable via `options.outputs` transformation stacks.
   */
  public async render(
    projectData: ProjectData,
    config: ExportConfig,
    onProgress: (percentage: number) => void,
    options: RenderOptions = {},
  ): Promise<RenderResult> {
    this.isCancelled = false;
    this.cancelController = new AbortController();
    const decoderPool = createDecoderWorkerPool({ label: "export" });
    const frameJobResolver = new FrameJobResolver();
    const frameGraphExecutor = new BatchFrameGraphExecutor();
    if (options.signal?.aborted) {
      this.cancel();
      throw createRenderAbortError();
    }
    const onAbort = () => this.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const { tracks, clips, assets, fps } = projectData;
    const { logicalWidth, logicalHeight, outputWidth, outputHeight } = config;

    const timelineSelection = options.timelineSelection ?? {
      start: 0,
      end: projectData.duration,
      clips,
      tracks,
    };
    const selectedClips = getIncludedClipsForSelection(
      timelineSelection,
      timelineSelection.clips,
    );
    const effectiveTracks = getIncludedTracksForSelection(
      timelineSelection,
      timelineSelection.tracks ?? tracks,
    );
    const startTick = timelineSelection.start;
    const renderFps = resolveSelectionFps(timelineSelection, fps);
    // Falls back to the clips' furthest presentation end when the selection
    // omits an explicit end. Presentation resolves against the full timeline
    // (the same source the AdjustmentEffectResolver uses below) so adjustment
    // speed is honoured; we measure only the clips this selection emits.
    // Quantize presentation on the canonical PROJECT-fps timeline grid (not
    // renderFps) so export and preview resolve identical clip footprints for
    // the same tick. renderFps only drives the export sample cadence + output
    // timestamps below.
    const inferredEndTick = computeFurthestPresentationEnd(
      projectData.tracks,
      projectData.clips,
      fps,
      selectedClips,
    );
    const requestedEndTick = Math.max(
      startTick,
      timelineSelection.end ?? inferredEndTick,
    );
    const frameStep = resolveSelectionFrameStep(timelineSelection);
    const ticksPerFrame = getTicksPerFrame(renderFps);
    const rawFrameCount = Math.max(
      1,
      Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
    );
    const totalFrames = snapFrameCountToStep(rawFrameCount, frameStep, "floor");
    const rangeDurationTicks = totalFrames * ticksPerFrame;

    const outputDefinitions = resolveOutputDefinitions(options).map((def) => ({
      ...def,
      fileHandle: config.fileHandle,
    }));
    const hasAudioOutput = outputDefinitions.some(
      (output) => output.includeAudio,
    );

    const { trackClipsByTrackId, maskClipsByParent, visualTracks } =
      buildVisualRenderData(
        effectiveTracks,
        selectedClips,
        options.includeTimelineMasks !== false,
      );

    const relevantForAudio = effectiveTracks.filter(
      (t) => !t.isMuted && t.isVisible,
    );
    const shouldRenderAudio = hasAudioOutput && relevantForAudio.length > 0;

    const frameTexture = RenderTexture.create({
      width: outputWidth,
      height: outputHeight,
      dynamic: true,
    });

    const outputEncoder = new TextureOutputEncoder(
      this.app,
      renderFps,
      outputDefinitions,
    );

    await outputEncoder.start();

    try {
      const adjustmentEffectResolver = new AdjustmentEffectResolver();
      // Project fps: the presentation grid must match preview, not the export
      // sample rate (renderFps).
      adjustmentEffectResolver.setAdjustmentSource(
        projectData.tracks,
        projectData.clips,
        fps,
      );

      // --- AUDIO EXPORT LOOP ---
      const rangeDurationSec = tickToMediaSeconds(rangeDurationTicks);

      if (shouldRenderAudio) {
        const audioRenderers = relevantForAudio.map(
          (t) => new TrackAudioRenderer(t.id, adjustmentEffectResolver),
        );

        const CHUNK_DURATION_SEC = 10;

        try {
          for (
            let chunkStartSec = 0;
            chunkStartSec < rangeDurationSec;
            chunkStartSec += CHUNK_DURATION_SEC
          ) {
            this.throwIfCancelled();

            const chunkDuration = Math.min(
              CHUNK_DURATION_SEC,
              rangeDurationSec - chunkStartSec,
            );

            const offlineCtx = new OfflineAudioContext(
              2,
              Math.ceil(chunkDuration * 48000),
              48000,
            );

            await Promise.all(
              audioRenderers.map(async (renderer, index) => {
                const trackId = relevantForAudio[index].id;
                const trackClips = trackClipsByTrackId.get(trackId) || [];

                renderer.prepareForChunk(0);

                await renderer.process(
                  offlineCtx,
                  offlineCtx.destination,
                  trackClips,
                  getAssetInput,
                  {
                    baseTicks:
                      startTick + mediaSecondsToTickExact(chunkStartSec),
                    baseContextTime: 0,
                  },
                  {
                    lookahead: chunkDuration + 0.1,
                    forceFlush: true,
                  },
                );
              }),
            );

            this.throwIfCancelled();

            const renderedBuffer = await offlineCtx.startRendering();
            this.throwIfCancelled();

            await outputEncoder.addAudioChunk(renderedBuffer);
            this.throwIfCancelled();

            const audioProgress =
              ((chunkStartSec + chunkDuration) / rangeDurationSec) * 10;
            onProgress(audioProgress);
          }
        } finally {
          audioRenderers.forEach((renderer) => renderer.dispose());
        }
      }

      await outputEncoder.closeAudioTracks();

      const startProgress = shouldRenderAudio ? 10 : 0;

      this.logicalStage.sortableChildren = true;
      this.orchestrator = new RenderGroupOrchestrator(this.logicalStage, {
        logicalDimensions: { width: logicalWidth, height: logicalHeight },
        adjustmentEffectResolver,
      });
      this.engines = visualTracks.map((track, index) => {
        const zIndex = visualTracks.length - 1 - index;
        const engine = new TrackRenderEngine(
          zIndex,
          undefined,
          this.app.renderer,
          {
            trackId: track.id,
            adjustmentEffectResolver,
            decoderPool,
          },
        );
        this.orchestrator!.registerTrack(track.id, engine.container);
        return engine;
      });
      // Adjustment-clip derivation reads the *full* project tracks + clips
      // (not the selection-filtered subset). The orchestrator still creates
      // and attaches a container for every derived group — even ones whose
      // reach contains no registered visual tracks — but those containers
      // hold no engines and so produce no pixels on the GPU. We tolerate
      // the empty-container cost so that adjustments whose adjustment
      // track was excluded from a selection export still apply to the
      // included visual tracks below, and to keep room for non-visual
      // engines (audio effects, etc.) to ride through the same forest in
      // the future without an a-priori filter.
      this.orchestrator.setAdjustmentSource(
        projectData.tracks,
        projectData.clips,
        fps,
      );
      const visualTrackOrder = visualTracks.map((track) => track.id);
      const resolutionTracks: FrameJobResolutionTrack[] = visualTracks.map(
        (track, index) => ({
          trackId: track.id,
          engine: this.engines[index],
          trackClips: trackClipsByTrackId.get(track.id) ?? [],
          maskClipsByParent,
        }),
      );

      for (let i = 0; i < totalFrames; i += 1) {
        this.throwIfCancelled();

        const currentTime = startTick + i * ticksPerFrame;
        // Output timestamp from the frame index (drift-free, monotonic) via the
        // single media-time boundary — never accumulated from ticks/seconds.
        const timestamp = frameIndexToOutputTimestamp(i, renderFps);

        const resolution = frameJobResolver.resolve({
          epoch: i + 1,
          presentationTick: currentTime,
          tracks: resolutionTracks,
          assets,
          logicalDimensions: {
            width: logicalWidth,
            height: logicalHeight,
          },
          fps: renderFps,
        });
        const graph = buildFrameResolutionGraph(i + 1, resolution.jobs);
        const adjustmentForest =
          adjustmentEffectResolver.deriveGroups(currentTime);
        const presentationPlan = buildScenePresentationPlan({
          epoch: i + 1,
          visualTrackOrder,
          jobs: resolution.jobs,
          adjustmentForest,
          outputIds: outputDefinitions.map((output) => output.id),
        });
        await frameGraphExecutor.execute(graph, resolution, {
          mode: "export",
          signal: this.cancelController?.signal,
        });
        this.throwIfCancelled();

        // Rewrite parenting (track engines into / out of group containers) and
        // apply group transforms before the GPU frame submit.
        this.orchestrator.syncPresentationPlan(
          currentTime,
          presentationPlan,
        );

        // Render timeline frame once to an offscreen texture.
        this.app.renderer.render({
          container: this.logicalStage,
          target: frameTexture,
          clear: true,
        });

        // Encode one or more outputs by applying per-output transform stacks.
        await outputEncoder.addTextureFrame(
          frameTexture,
          timestamp,
          1 / renderFps,
        );

        this.throwIfCancelled();

        if (i % 5 === 0) {
          const videoProgress = (i / totalFrames) * (100 - startProgress);
          onProgress(startProgress + videoProgress);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      this.throwIfCancelled();

      const renderHealth = this.collectRenderHealth(visualTracks);
      this.warnOnDegradedRenderHealth(renderHealth, "selection render");

      const { blobs: outputs, analyses: outputAnalyses } =
        await outputEncoder.finalize();
      const primaryOutputId = outputs.video
        ? "video"
        : (Object.keys(outputs)[0] ?? null);
      if (!primaryOutputId) {
        throw new Error("Renderer produced no video outputs");
      }

      return {
        video: outputs[primaryOutputId],
        mask: outputs.mask,
        outputs,
        outputAnalyses,
        renderHealth,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.cancelController = null;
      outputEncoder.dispose();
      frameTexture.destroy(true);
      this.dispose();
      frameGraphExecutor.dispose();
      decoderPool.dispose();
    }
  }

  public async renderStill(
    projectData: ProjectData,
    config: ExportConfig,
    tick: number,
    options: RenderStillOptions = {},
  ): Promise<Blob> {
    this.isCancelled = false;
    this.cancelController = new AbortController();
    const decoderPool = createDecoderWorkerPool({ label: "export" });
    const frameJobResolver = new FrameJobResolver();
    const frameGraphExecutor = new BatchFrameGraphExecutor();
    if (options.signal?.aborted) {
      this.cancel();
      throw createRenderAbortError();
    }
    const onAbort = () => this.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const { assets, fps } = projectData;
    const availableTracks =
      options.timelineSelection?.tracks ?? projectData.tracks;
    const availableClips =
      options.timelineSelection?.clips ?? projectData.clips;
    const tracks = options.timelineSelection
      ? getIncludedTracksForSelection(
          options.timelineSelection,
          availableTracks,
        )
      : availableTracks;
    const clips = options.timelineSelection
      ? getIncludedClipsForSelection(options.timelineSelection, availableClips)
      : availableClips;
    const { logicalWidth, logicalHeight } = config;
    const { trackClipsByTrackId, maskClipsByParent, visualTracks } =
      buildVisualRenderData(
        tracks,
        clips,
        options.includeTimelineMasks !== false,
      );

    try {
      const adjustmentEffectResolver = new AdjustmentEffectResolver();
      adjustmentEffectResolver.setAdjustmentSource(
        projectData.tracks,
        projectData.clips,
        fps,
      );

      this.logicalStage.sortableChildren = true;
      this.orchestrator = new RenderGroupOrchestrator(this.logicalStage, {
        logicalDimensions: { width: logicalWidth, height: logicalHeight },
        adjustmentEffectResolver,
      });
      this.engines = visualTracks.map((track, index) => {
        const zIndex = visualTracks.length - 1 - index;
        const engine = new TrackRenderEngine(
          zIndex,
          undefined,
          this.app.renderer,
          {
            trackId: track.id,
            adjustmentEffectResolver,
            decoderPool,
          },
        );
        this.orchestrator!.registerTrack(track.id, engine.container);
        return engine;
      });
      // Derivation reads the *full* project tracks + clips, including
      // empty-container behaviour for unregistered reach. See the comment
      // on the same call in render() above.
      this.orchestrator.setAdjustmentSource(
        projectData.tracks,
        projectData.clips,
        fps,
      );
      const visualTrackOrder = visualTracks.map((track) => track.id);
      const resolutionTracks: FrameJobResolutionTrack[] = visualTracks.map(
        (track, index) => ({
          trackId: track.id,
          engine: this.engines[index],
          trackClips: trackClipsByTrackId.get(track.id) ?? [],
          maskClipsByParent,
        }),
      );
      const resolution = frameJobResolver.resolve({
        epoch: 1,
        presentationTick: tick,
        tracks: resolutionTracks,
        assets,
        logicalDimensions: {
          width: logicalWidth,
          height: logicalHeight,
        },
        fps,
      });
      const graph = buildFrameResolutionGraph(1, resolution.jobs);
      const presentationPlan = buildScenePresentationPlan({
        epoch: 1,
        visualTrackOrder,
        jobs: resolution.jobs,
        adjustmentForest: adjustmentEffectResolver.deriveGroups(tick),
      });
      await frameGraphExecutor.execute(graph, resolution, {
        mode: "export",
        signal: this.cancelController?.signal,
      });
      this.throwIfCancelled();

      this.warnOnDegradedRenderHealth(
        this.collectRenderHealth(visualTracks),
        "still capture",
      );

      // Rewrite parenting and apply group transforms before the GPU submit.
      this.orchestrator.syncPresentationPlan(tick, presentationPlan);

      this.app.renderer.render({
        container: this.logicalStage,
        clear: true,
      });
      this.throwIfCancelled();

      return canvasToBlob(
        this.app.canvas,
        options.mimeType ?? "image/png",
        options.quality,
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.cancelController = null;
      this.dispose();
      frameGraphExecutor.dispose();
      decoderPool.dispose();
    }
  }

  private collectRenderHealth(
    visualTracks: readonly { id: string }[],
  ): ExportRenderHealth {
    const totals = createEmptyStrictRenderHealth();
    const byTrack: Record<string, StrictRenderHealth> = {};
    this.engines.forEach((engine, index) => {
      const health = engine.consumeStrictRenderHealth();
      byTrack[visualTracks[index]?.id ?? `track-${index}`] = health;
      totals.replies += health.replies;
      totals.nullFrames += health.nullFrames;
      totals.missingRendererFrames += health.missingRendererFrames;
      totals.errorFrames += health.errorFrames;
    });
    return { totals, byTrack };
  }

  private warnOnDegradedRenderHealth(
    renderHealth: ExportRenderHealth,
    context: string,
  ): void {
    const { totals, byTrack } = renderHealth;
    if (totals.nullFrames === 0 && totals.errorFrames === 0) {
      return;
    }

    const degradedTracks = Object.entries(byTrack)
      .filter(
        ([, health]) => health.nullFrames > 0 || health.errorFrames > 0,
      )
      .map(([trackId, health]) => {
        const blankSuffix = isBlankStrictRenderHealth(health)
          ? " (ALL frames blank)"
          : "";
        return `${trackId}: ${health.nullFrames}/${health.replies} frameless${blankSuffix}, missingRenderer=${health.missingRendererFrames}, errors=${health.errorFrames}`;
      });
    console.warn(
      `[ExportRenderer] ${context} produced degraded frames — ${degradedTracks.join("; ")}`,
    );
  }

  public cancel() {
    if (this.isCancelled) return;
    this.isCancelled = true;
    this.cancelController?.abort();
    const abortError = createRenderAbortError();
    this.engines.forEach((engine) => engine.cancelPendingFrame(abortError));
  }

  public dispose() {
    this.orchestrator?.dispose();
    this.orchestrator = null;
    this.engines.forEach((engine) => engine.dispose());
    this.engines = [];
    this.app.destroy(false, { children: true, texture: true });
  }

  private throwIfCancelled() {
    if (this.isCancelled || this.cancelController?.signal.aborted) {
      throw createRenderAbortError();
    }
  }
}
