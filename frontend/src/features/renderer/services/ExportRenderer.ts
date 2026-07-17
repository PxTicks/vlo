import { Application, Container, RenderTexture } from "pixi.js";
import { enableAdvancedBlendModes } from "../../../core/pixi/advancedBlendModes";
import type {
  TimelineTrack,
  TimelineClip,
  CompositeAsset,
  MaskTimelineClip,
  TimelineSelection,
  Transition,
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
import { TemporalRenderCoordinator } from "./TemporalRenderCoordinator";
import {
  collectTemporalRenderingRequirements,
  type TemporalRenderingRequirements,
} from "../../transformations/catalogue/temporalRenderingRequirements";
import type { FilterRenderContext } from "../../transformations/catalogue/types";
import {
  TrackRenderEngine,
  createEmptyStrictRenderHealth,
  isBlankStrictRenderHealth,
  type StrictRenderHealth,
} from "./TrackRenderEngine";
import { TrackAudioRenderer } from "./TrackAudioRenderer";
import {
  estimateAudioEffectTailSeconds,
  getAudioEffectTransforms,
} from "./audioEffectChain";
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
  createFilterStackTransform,
  createOpaqueOutputColorMatrixFilter,
} from "../utils/outputTransformStack";
import {
  BatchFrameGraphExecutor,
  FrameJobResolver,
  buildFrameResolutionGraph,
  buildScenePresentationPlan,
  type FrameJobResolutionTrack,
} from "./framePlanning";
import { resolveTransitionFrame } from "../../transitions/rendering/TransitionResolver";
import { CompositeSceneRuntimeManager } from "./CompositeSceneRuntime";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

const AUDIO_EXPORT_CHUNK_DURATION_SEC = 10;
const MAX_AUDIO_EXPORT_PREROLL_SEC = 30;
const AUDIO_EXPORT_SAMPLE_RATE = 48_000;

interface ActiveTemporalFrameScope {
  requirements: TemporalRenderingRequirements;
  earliestTick: number;
}

function collectActiveTemporalFrameScope(
  presentationTick: number,
  resolutionTracks: readonly FrameJobResolutionTrack[],
  adjustmentEffectResolver: AdjustmentEffectResolver,
): ActiveTemporalFrameScope {
  const transformationSets: TimelineClip["transformations"][] = [];
  const temporalStartTicks: number[] = [];
  for (const track of resolutionTracks) {
    const active = track.engine.resolveActiveClipAtPresentation(
      track.trackClips,
      presentationTick,
    );
    if (!active) continue;
    const transformations = active.activeClip.transformations ?? [];
    transformationSets.push(transformations);
    if (
      collectTemporalRenderingRequirements([transformations]).timeDependency !==
      "none"
    ) {
      temporalStartTicks.push(active.presentationStart);
    }
  }

  const collectGroups = (
    groups: ReturnType<AdjustmentEffectResolver["deriveGroups"]>,
  ): void => {
    for (const group of groups) {
      const transformations = group.transformations ?? [];
      transformationSets.push(transformations);
      if (
        collectTemporalRenderingRequirements([transformations])
          .timeDependency !== "none"
      ) {
        const localElapsed = Math.max(
          0,
          (group.sampleTick ?? presentationTick) - group.start,
        );
        temporalStartTicks.push(presentationTick - localElapsed);
      }
      collectGroups(group.children);
    }
  };
  collectGroups(adjustmentEffectResolver.deriveGroups(presentationTick));

  return {
    requirements: collectTemporalRenderingRequirements(transformationSets),
    earliestTick:
      temporalStartTicks.length > 0 ? Math.min(...temporalStartTicks) : 0,
  };
}

function estimateAudioExportPrerollSeconds(
  clips: readonly TimelineClip[],
): number {
  const tailSeconds = clips.reduce((maxTail, clip) => {
    const transforms = getAudioEffectTransforms(clip);
    if (transforms.length === 0) return maxTail;
    return Math.max(maxTail, estimateAudioEffectTailSeconds(transforms));
  }, 0);
  return Math.min(MAX_AUDIO_EXPORT_PREROLL_SEC, tailSeconds);
}

function createAudioBufferSlice(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  startSeconds: number,
  durationSeconds: number,
): AudioBuffer {
  const sampleRate = source.sampleRate;
  const startFrame = Math.max(
    0,
    Math.min(source.length, Math.round(startSeconds * sampleRate)),
  );
  const frameCount = Math.max(0, Math.ceil(durationSeconds * sampleRate));
  const channelCount = Math.max(1, source.numberOfChannels);
  const sliced = ctx.createBuffer(channelCount, frameCount, sampleRate);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const sourceChannel = source.getChannelData(
      Math.min(channel, source.numberOfChannels - 1),
    );
    const endFrame = Math.min(source.length, startFrame + frameCount);
    sliced.copyToChannel(sourceChannel.subarray(startFrame, endFrame), channel);
  }

  return sliced;
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
      transformStack: [
        createFilterStackTransform([createOpaqueOutputColorMatrixFilter()]),
      ],
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
  transitions?: Transition[];
  assets: Asset[];
  composites?: CompositeAsset[];
  duration: number;
  fps: number;
}

export interface RenderOptions {
  timelineSelection?: TimelineSelection;
  format?: "mp4";
  outputs?: OutputVideoDefinition[];
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
  /**
   * Optional headed parity/testing seam. Called from the final project
   * composite after scene rendering and before output transforms/encoding.
   * The pixels are copied, so callers may retain them after the next frame.
   */
  onBeforeEncodeFrame?: (
    frame: RenderedFramePixelCapture,
  ) => void | Promise<void>;
}

export interface RenderedFramePixelCapture {
  frameIndex: number;
  presentationTick: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
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
    const frameGraphExecutor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: new CompositeSceneRuntimeManager(
        this.app.renderer,
        decoderPool,
      ),
      onCompositeSceneError: (error, job) => {
        console.warn(
          `[CompositeScene] Export direct render failed for '${job.activeClip.id}'; using a valid bake fallback when available.`,
          error,
        );
      },
    });
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
        const audioPrerollSeconds = estimateAudioExportPrerollSeconds(
          relevantForAudio.flatMap(
            (track) => trackClipsByTrackId.get(track.id) ?? [],
          ),
        );

        for (
          let chunkStartSec = 0;
          chunkStartSec < rangeDurationSec;
          chunkStartSec += AUDIO_EXPORT_CHUNK_DURATION_SEC
        ) {
          this.throwIfCancelled();

          const chunkDuration = Math.min(
            AUDIO_EXPORT_CHUNK_DURATION_SEC,
            rangeDurationSec - chunkStartSec,
          );
          const prerollSeconds = Math.min(chunkStartSec, audioPrerollSeconds);
          const renderStartSec = chunkStartSec - prerollSeconds;
          const renderDuration = prerollSeconds + chunkDuration;

          const offlineCtx = new OfflineAudioContext(
            2,
            Math.ceil(renderDuration * AUDIO_EXPORT_SAMPLE_RATE),
            AUDIO_EXPORT_SAMPLE_RATE,
          );

          const audioRenderers = relevantForAudio.map(
            (track) => new TrackAudioRenderer(track.id, adjustmentEffectResolver),
          );
          let renderedBuffer: AudioBuffer | null = null;

          try {
            await Promise.all(
              audioRenderers.map(async (renderer, index) => {
                const trackId = relevantForAudio[index].id;
                const trackClips = trackClipsByTrackId.get(trackId) || [];

                await renderer.process(
                  offlineCtx,
                  offlineCtx.destination,
                  trackClips,
                  getAssetInput,
                  {
                    baseTicks:
                      startTick + mediaSecondsToTickExact(renderStartSec),
                    baseContextTime: 0,
                  },
                  {
                    lookahead: renderDuration + 0.1,
                    forceFlush: true,
                  },
                );
              }),
            );

            this.throwIfCancelled();

            renderedBuffer = await offlineCtx.startRendering();
          } finally {
            audioRenderers.forEach((renderer) => renderer.dispose());
          }

          this.throwIfCancelled();
          if (!renderedBuffer) {
            throw new Error("Audio export chunk did not produce a buffer");
          }

          const outputBuffer =
            prerollSeconds > 0
              ? createAudioBufferSlice(
                  offlineCtx,
                  renderedBuffer,
                  prerollSeconds,
                  chunkDuration,
                )
              : renderedBuffer;

          await outputEncoder.addAudioChunk(outputBuffer);
          this.throwIfCancelled();

          const audioProgress =
            ((chunkStartSec + chunkDuration) / rangeDurationSec) * 10;
          onProgress(audioProgress);
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

      const temporalCoordinator = new TemporalRenderCoordinator();
      let renderEpoch = 0;
      const renderTimelineFrame = async (
        currentTime: number,
        render: FilterRenderContext,
      ): Promise<void> => {
        renderEpoch += 1;
        const adjustmentForest =
          adjustmentEffectResolver.deriveGroups(currentTime);
        const transitionFrame = resolveTransitionFrame({
          tracks: projectData.tracks,
          clips: projectData.clips,
          transitions: projectData.transitions ?? [],
          fps,
          presentationTick: currentTime,
          logicalDimensions: {
            width: logicalWidth,
            height: logicalHeight,
          },
          visualTrackOrder,
          adjustmentForest,
        });
        const resolution = frameJobResolver.resolve({
          epoch: renderEpoch,
          presentationTick: currentTime,
          tracks: resolutionTracks,
          assets,
          composites: projectData.composites,
          logicalDimensions: {
            width: logicalWidth,
            height: logicalHeight,
          },
          fps: renderFps,
          compositeProjectFps: fps,
          transitionTransformsByClipId: transitionFrame.transformsByClipId,
        });
        const graph = buildFrameResolutionGraph(renderEpoch, resolution.jobs);
        const presentationPlan = buildScenePresentationPlan({
          epoch: renderEpoch,
          visualTrackOrder,
          jobs: resolution.jobs,
          adjustmentForest,
          zIndexOverrides: transitionFrame.zIndexOverrides,
          transitionColorLayers: transitionFrame.colorLayers,
          outputIds: outputDefinitions.map((output) => output.id),
        });
        await frameGraphExecutor.execute(graph, resolution, {
          mode: "export",
          signal: this.cancelController?.signal,
          render,
        });
        this.throwIfCancelled();
        this.orchestrator!.syncPresentationPlan(
          currentTime,
          presentationPlan,
          render,
        );
        this.app.renderer.render({
          container: this.logicalStage,
          target: frameTexture,
          clear: true,
        });
      };

      for (let i = 0; i < totalFrames; i += 1) {
        this.throwIfCancelled();

        const currentTime = startTick + i * ticksPerFrame;
        // Output timestamp from the frame index (drift-free, monotonic) via the
        // single media-time boundary — never accumulated from ticks/seconds.
        const timestamp = frameIndexToOutputTimestamp(i, renderFps);

        const temporalScope = collectActiveTemporalFrameScope(
          currentTime,
          resolutionTracks,
          adjustmentEffectResolver,
        );
        const temporalPlan = temporalCoordinator.plan({
          presentationTick: currentTime,
          fps: renderFps,
          mode: "export",
          requirements: temporalScope.requirements,
          earliestTick: temporalScope.earliestTick,
        });
        for (const warmup of temporalPlan.warmup) {
          await renderTimelineFrame(warmup.presentationTimeTicks, warmup);
        }
        await renderTimelineFrame(currentTime, temporalPlan.target);

        if (options.onBeforeEncodeFrame) {
          const extracted = this.app.renderer.extract.pixels({
            target: frameTexture,
          });
          await options.onBeforeEncodeFrame({
            frameIndex: i,
            presentationTick: currentTime,
            width: extracted.width,
            height: extracted.height,
            pixels: new Uint8ClampedArray(extracted.pixels),
          });
        }

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
    const frameGraphExecutor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: new CompositeSceneRuntimeManager(
        this.app.renderer,
        decoderPool,
      ),
      onCompositeSceneError: (error, job) => {
        console.warn(
          `[CompositeScene] Still direct render failed for '${job.activeClip.id}'; using a valid bake fallback when available.`,
          error,
        );
      },
    });
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
      const temporalCoordinator = new TemporalRenderCoordinator();
      const temporalScope = collectActiveTemporalFrameScope(
        tick,
        resolutionTracks,
        adjustmentEffectResolver,
      );
      const temporalPlan = temporalCoordinator.plan({
        presentationTick: tick,
        fps,
        mode: "still",
        requirements: temporalScope.requirements,
        earliestTick: temporalScope.earliestTick,
      });
      const warmupTarget =
        temporalPlan.warmup.length > 0
          ? RenderTexture.create({
              width: Math.max(1, this.app.renderer.width),
              height: Math.max(1, this.app.renderer.height),
            })
          : null;
      let renderEpoch = 0;
      const renderTimelineFrame = async (
        currentTime: number,
        render: FilterRenderContext,
        target?: RenderTexture,
      ): Promise<void> => {
        renderEpoch += 1;
        const adjustmentForest =
          adjustmentEffectResolver.deriveGroups(currentTime);
        const transitionFrame = resolveTransitionFrame({
          tracks: projectData.tracks,
          clips: projectData.clips,
          transitions: projectData.transitions ?? [],
          fps,
          presentationTick: currentTime,
          logicalDimensions: {
            width: logicalWidth,
            height: logicalHeight,
          },
          visualTrackOrder,
          adjustmentForest,
        });
        const resolution = frameJobResolver.resolve({
          epoch: renderEpoch,
          presentationTick: currentTime,
          tracks: resolutionTracks,
          assets,
          composites: projectData.composites,
          logicalDimensions: {
            width: logicalWidth,
            height: logicalHeight,
          },
          fps,
          compositeProjectFps: fps,
          transitionTransformsByClipId: transitionFrame.transformsByClipId,
        });
        const graph = buildFrameResolutionGraph(renderEpoch, resolution.jobs);
        const presentationPlan = buildScenePresentationPlan({
          epoch: renderEpoch,
          visualTrackOrder,
          jobs: resolution.jobs,
          adjustmentForest,
          zIndexOverrides: transitionFrame.zIndexOverrides,
          transitionColorLayers: transitionFrame.colorLayers,
        });
        await frameGraphExecutor.execute(graph, resolution, {
          mode: "export",
          signal: this.cancelController?.signal,
          render,
        });
        this.throwIfCancelled();
        this.orchestrator!.syncPresentationPlan(
          currentTime,
          presentationPlan,
          render,
        );
        this.app.renderer.render({
          container: this.logicalStage,
          ...(target ? { target } : {}),
          clear: true,
        });
      };
      try {
        for (const warmup of temporalPlan.warmup) {
          await renderTimelineFrame(
            warmup.presentationTimeTicks,
            warmup,
            warmupTarget ?? undefined,
          );
        }
        await renderTimelineFrame(tick, temporalPlan.target);
      } finally {
        warmupTarget?.destroy(true);
      }

      this.warnOnDegradedRenderHealth(
        this.collectRenderHealth(visualTracks),
        "still capture",
      );
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
