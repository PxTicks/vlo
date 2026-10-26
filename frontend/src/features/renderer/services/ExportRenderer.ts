import { convertLegacyTimelineSelection, projectTimelineSelection } from "../../timeline/time";
import type { ExportPhase } from "../../../core/export/exportProgress";
import type { ExportDiagnostic } from "./exportDiagnostics";
import type { ExportFileTarget } from "./ExportFileTarget";
import { Application, Container, RenderTexture } from "pixi.js";
import { enableAdvancedBlendModes } from "../../../core/pixi/advancedBlendModes";
import {
  recordGpuContextInitFailure,
  registerGpuContext,
  type GpuContextRegistration,
} from "../../../core/pixi/gpuContextDiagnostics";
import type {
  TimelineTrack,
  TimelineClip,
  CompositeAsset,
  MaskTimelineClip,
  TimelineSelection,
  Transition,
} from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import {
  frameIndexToOutputTimestamp,
  mediaSecondsToTickExact,
  tickToMediaSeconds,
} from "../utils/mediaTime";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import { RenderGroupOrchestrator } from "./RenderGroupOrchestrator";
import { TemporalRenderCoordinator } from "./TemporalRenderCoordinator";
import type { FilterRenderContext } from "../../transformations/catalogue/types";
import {
  TrackRenderEngine,
  createEmptyStrictRenderHealth,
  isBlankStrictRenderHealth,
  type StrictRenderHealth,
} from "./TrackRenderEngine";
import { CompositeAudioTrackRenderer } from "./CompositeAudioTrackRenderer";
import {
  estimateAudioEffectTailSeconds,
  getAudioEffectTransforms,
} from "./audioEffectChain";
import { createDecoderWorkerPool } from "./DecoderWorkerPool";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import { yieldToEventLoop } from "../utils/yieldToEventLoop";
import { getAssetInput } from "../../userAssets";
import {
  getIncludedClipsForSelection,
  getIncludedTracksForSelection,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameOffset,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../../timelineSelection";
import {
  TextureOutputEncoder,
  type OutputVideoAnalysis,
  type OutputVideoDefinition,
  type OutputVideoFormat,
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
  type CompositeSourcePolicySnapshot,
} from "./framePlanning";
import { isAbortError } from "./framePlanning/BatchFrameGraphExecutor";
import { startExportDebugLog, type ExportDebugLog } from "./exportDebugLog";
import { resolveTransitionFrame } from "../../transitions/rendering/TransitionResolver";
import { CompositeSceneRuntimeManager } from "./CompositeSceneRuntime";
import {
  collectTemporalFrameScope,
  type TemporalFrameScope,
} from "./TemporalFrameScopeResolver";
import { buildSelectionProjectData } from "../utils/buildSelectionProjectData";

function createRenderAbortError(): Error {
  const error = new Error("Render cancelled");
  error.name = "AbortError";
  return error;
}

const AUDIO_EXPORT_CHUNK_DURATION_SEC = 10;
const MAX_AUDIO_EXPORT_PREROLL_SEC = 30;
/**
 * Each chunk is mixed in a fresh context, so the renderer's 3 ms de-click
 * fade-in would otherwise dip continuous audio at every chunk seam. Render a
 * little earlier and discard it so the fade falls outside the kept audio.
 */
const AUDIO_EXPORT_SEAM_PREROLL_SEC = 0.01;
const AUDIO_EXPORT_SAMPLE_RATE = 48_000;

function collectActiveTemporalFrameScope(
  presentationTick: number,
  resolutionTracks: readonly FrameJobResolutionTrack[],
  adjustmentEffectResolver: AdjustmentEffectResolver,
  stableClips: readonly TimelineClip[],
): TemporalFrameScope {
  return collectTemporalFrameScope({
    presentationTick,
    tracks: resolutionTracks.map((track) => ({
      trackId: track.trackId,
      trackClips: track.trackClips,
      activeClipResolver: track.engine,
    })),
    stableClips,
    adjustmentEffectResolver,
  });
}

function estimateAudioExportPrerollSeconds(
  clips: readonly TimelineClip[],
): number {
  const tailSeconds = clips.reduce((maxTail, clip) => {
    const transforms = getAudioEffectTransforms(clip);
    if (transforms.length === 0) return maxTail;
    return Math.max(maxTail, estimateAudioEffectTailSeconds(transforms));
  }, 0);
  return Math.min(
    MAX_AUDIO_EXPORT_PREROLL_SEC,
    Math.max(AUDIO_EXPORT_SEAM_PREROLL_SEC, tailSeconds),
  );
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

export function resolveOutputDefinitions(
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
    if (options.preserveAlpha) {
      throw new Error(
        "preserveAlpha cannot be combined with explicit outputs; configure each WebM output and transform stack explicitly",
      );
    }
    const definitions = options.outputs.map((definition, index) => {
      return {
        ...definition,
        includeAudio: definition.includeAudio ?? index === 0,
      };
    });
    ensureUniqueIds(definitions);
    return definitions;
  }

  if (options.preserveAlpha && fallbackFormat !== "webm") {
    throw new Error("Alpha-preserving video output requires WebM");
  }

  const defaults: OutputVideoDefinition[] = [
    {
      id: "video",
      format: fallbackFormat,
      includeAudio: options.includeAudio ?? true,
      keyFrameInterval: options.keyFrameInterval,
      transformStack: options.preserveAlpha
        ? []
        : [
            createFilterStackTransform([
              createOpaqueOutputColorMatrixFilter(),
            ]),
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
  /**
   * A caller-owned stream for the single output, for a disk export whose
   * destination is not a browser file handle.
   */
  outputTarget?: ExportFileTarget;
  /**
   * Names this renderer in the debug-mode console log, which then also times
   * context and pool setup. Callers that run their own log leave it unset.
   */
  debugLabel?: string;
}

export interface ProjectData {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions?: Transition[];
  assets: Asset[];
  composites?: CompositeAsset[];
  duration: number;
  fps: number;
  /** Immutable for the lifetime of this render/export invocation. */
  compositeSourcePolicy?: CompositeSourcePolicySnapshot;
}

export interface RenderOptions {
  onPhaseChange?: (phase: ExportPhase) => void;
  onDiagnostic?: (event: ExportDiagnostic) => void;
  timelineSelection?: TimelineSelection;
  format?: OutputVideoFormat;
  /** Seconds between keyframes in the default output. */
  keyFrameInterval?: number;
  /** Whether the default output carries a soundtrack. Defaults to true. */
  includeAudio?: boolean;
  /** Keep transparent project pixels; requires an alpha-capable output. */
  preserveAlpha?: boolean;
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
  video?: Blob;
  /** Committed file-backed outputs, which intentionally have no Blob. */
  files?: Record<string, FileSystemFileHandle>;
  streamedOutputIds?: readonly string[];
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
  private outputEncoder: TextureOutputEncoder | null = null;
  private gpuContext: GpuContextRegistration;
  private debugLog: ExportDebugLog | null;
  private renderStarted = false;

  private constructor(
    app: Application,
    logicalStage: Container,
    gpuContext: GpuContextRegistration,
    debugLog: ExportDebugLog | null,
  ) {
    this.app = app;
    this.logicalStage = logicalStage;
    this.gpuContext = gpuContext;
    this.debugLog = debugLog;
  }

  /**
   * Factory method to create an initialized ExportRenderer
   */
  public static async create(config: ExportConfig): Promise<ExportRenderer> {
    const {
      logicalWidth,
      logicalHeight,
      outputWidth,
      outputHeight,
      backgroundAlpha = 1,
    } = config;

    // 1. Initialize Headless App (Physical Resolution)
    // Register advanced blend modes so exported clip blend modes match preview.
    // Started before the context exists, so the log covers setup too.
    const debugLog = config.debugLabel
      ? startExportDebugLog(config.debugLabel)
      : null;
    enableAdvancedBlendModes();
    const app = new Application();

    try {
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
        // Every export frame is rendered explicitly. A started ticker would also
        // redraw the whole stage to the unseen canvas on every animation frame;
        // on vlo_03 that tripled export time wherever rAF runs (a visible
        // editor, or a hidden one kept alive by the progress PiP).
        autoStart: false,
      });
    } catch (cause) {
      recordGpuContextInitFailure(
        "offscreen-render",
        outputWidth,
        outputHeight,
        cause,
      );
      debugLog?.finish("failed");
      throw cause;
    }
    const gpuContext = registerGpuContext("offscreen-render", app);
    debugLog?.mark(`renderer ready (${outputWidth}x${outputHeight})`);

    // 2. Setup the "Logical Stage"
    const logicalStage = new Container();

    // Map the logical rect onto the output rect on both axes. A height-only
    // scale leaves content off-frame whenever the logical canvas's ratio
    // differs from the output's by rounding (9:16 logical is 608x1080, which
    // is 0.09% wider than 9:16, so it overhangs a 1080x1920 output).
    logicalStage.scale.set(
      outputWidth / logicalWidth,
      outputHeight / logicalHeight,
    );
    app.stage.addChild(logicalStage);

    return new ExportRenderer(app, logicalStage, gpuContext, debugLog);
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
    const debugLog = this.debugLog;
    if (!debugLog) {
      return this.renderOutputs(projectData, config, onProgress, options);
    }
    return this.withDebugLog(debugLog, () =>
      this.renderOutputs(projectData, config, onProgress, {
        ...options,
        onPhaseChange: (phase) => {
          debugLog.onPhaseChange(phase);
          options.onPhaseChange?.(phase);
        },
        onDiagnostic: (event) => {
          debugLog.onDiagnostic(event);
          options.onDiagnostic?.(event);
        },
      }),
    );
  }

  private async renderOutputs(
    projectData: ProjectData,
    config: ExportConfig,
    onProgress: (percentage: number) => void,
    options: RenderOptions,
  ): Promise<RenderResult> {
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
    let frameTexture: RenderTexture | null = null;
    let outputEncoder: TextureOutputEncoder | null = null;
    const onAbort = () => this.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) this.cancel();
      this.throwIfCancelled();
      options.onPhaseChange?.("preparing");

      const savedSelection = options.timelineSelection
        ? convertLegacyTimelineSelection(options.timelineSelection, projectData.fps) : undefined;
      const renderProjectData = savedSelection
        ? buildSelectionProjectData(projectData, savedSelection)
        : projectData;
      const { tracks, clips, assets, fps } = renderProjectData;
      const { logicalWidth, logicalHeight, outputWidth, outputHeight } = config;

      const timelineSelection: TimelineSelection = savedSelection ?? projectTimelineSelection({
        start: 0,
        end: renderProjectData.duration,
        clips,
        tracks,
      }, projectData);
      const selectedClips = getIncludedClipsForSelection(
        timelineSelection,
        clips,
      );
      const effectiveTracks = getIncludedTracksForSelection(
        timelineSelection,
        tracks,
      );
      const startTick = 0;
      const renderFps = resolveSelectionFps(timelineSelection, fps);
      const requestedEndTick = timelineSelection.durationTicks;
      const frameStep = resolveSelectionFrameStep(timelineSelection);
      const frameOffset = resolveSelectionFrameOffset(timelineSelection);
      const ticksPerFrame = getTicksPerFrame(renderFps);
      const rawFrameCount = Math.max(
        1,
        Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
      );
      const totalFrames = snapFrameCountToStep(
        rawFrameCount,
        frameStep,
        "floor",
        frameOffset,
      );
      const rangeDurationTicks = totalFrames * ticksPerFrame;

      const definitions = resolveOutputDefinitions(options);
      if ((config.fileHandle || config.outputTarget) && definitions.length !== 1) {
        throw new Error("A disk export requires exactly one output");
      }
      const outputDefinitions = definitions.map((def) => ({
        ...def,
        fileHandle: config.fileHandle ?? def.fileHandle,
        outputTarget: config.outputTarget ?? def.outputTarget,
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

      frameTexture = RenderTexture.create({
        width: outputWidth,
        height: outputHeight,
        dynamic: true,
      });

      outputEncoder = new TextureOutputEncoder(
        this.app,
        renderFps,
        outputDefinitions,
        { onPhaseChange: options.onPhaseChange, onDiagnostic: options.onDiagnostic },
      );
      this.outputEncoder = outputEncoder;
      await outputEncoder.start();
      this.throwIfCancelled();
      const adjustmentEffectResolver = new AdjustmentEffectResolver();
      // Project fps: the presentation grid must match preview, not the export
      // sample rate (renderFps).
      adjustmentEffectResolver.setAdjustmentSource(
        renderProjectData.tracks,
        renderProjectData.clips,
        fps,
      );

      // --- AUDIO EXPORT LOOP ---
      const rangeDurationSec = tickToMediaSeconds(rangeDurationTicks);

      if (shouldRenderAudio) {
        options.onPhaseChange?.("audio");
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
            (track) =>
              new CompositeAudioTrackRenderer(
                track.id,
                adjustmentEffectResolver,
                {
                  tracks: renderProjectData.tracks,
                  clips: renderProjectData.clips,
                  composites: renderProjectData.composites ?? [],
                  assets: renderProjectData.assets,
                  projectFps: fps,
                  logicalDimensions: {
                    width: logicalWidth,
                    height: logicalHeight,
                  },
                  sourcePolicy: renderProjectData.compositeSourcePolicy,
                },
              ),
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

      options.onPhaseChange?.("rendering");
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
      // Adjustment-clip derivation reads the full render topology (before the
      // included-track filter). For a saved selection this is its snapshot,
      // never the currently open timeline. The orchestrator still creates
      // and attaches a container for every derived group — even ones whose
      // reach contains no registered visual tracks — but those containers
      // hold no engines and so produce no pixels on the GPU. We tolerate
      // the empty-container cost so that adjustments whose adjustment
      // track was excluded from a selection export still apply to the
      // included visual tracks below, and to keep room for non-visual
      // engines (audio effects, etc.) to ride through the same forest in
      // the future without an a-priori filter.
      this.orchestrator.setAdjustmentSource(
        renderProjectData.tracks,
        renderProjectData.clips,
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
          tracks: renderProjectData.tracks,
          clips: renderProjectData.clips,
          transitions: renderProjectData.transitions ?? [],
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
          composites: renderProjectData.composites,
          compositeSourcePolicy: renderProjectData.compositeSourcePolicy,
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
          target: frameTexture!,
          clear: true,
        });
      };

      for (let i = 0; i < totalFrames; i += 1) {
        this.throwIfCancelled();
        const frameStartedAt = options.onDiagnostic ? performance.now() : 0;

        const currentTime = startTick + i * ticksPerFrame;
        // Output timestamp from the frame index (drift-free, monotonic) via the
        // single media-time boundary — never accumulated from ticks/seconds.
        const timestamp = frameIndexToOutputTimestamp(i, renderFps);

        const temporalScope = collectActiveTemporalFrameScope(
          currentTime,
          resolutionTracks,
          adjustmentEffectResolver,
          renderProjectData.clips,
        );
        const temporalPlan = temporalCoordinator.plan({
          presentationTick: currentTime,
          fps: renderFps,
          mode: "export",
          requirements: temporalScope.requirements,
          earliestTick: temporalScope.earliestTick,
          topologyKey: temporalScope.topologyKey,
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
            presentationTick: timelineSelection.anchor + currentTime,
            width: extracted.width,
            height: extracted.height,
            pixels: new Uint8ClampedArray(extracted.pixels),
          });
        }

        // Encode one or more outputs by applying per-output transform stacks.
        const outputStartedAt = options.onDiagnostic ? performance.now() : 0;
        await outputEncoder.addTextureFrame(
          frameTexture,
          timestamp,
          1 / renderFps,
        );
        options.onDiagnostic?.({ kind: "frame", frameIndex: i,
          renderMilliseconds: outputStartedAt - frameStartedAt,
          outputMilliseconds: performance.now() - outputStartedAt });

        this.throwIfCancelled();

        if (i % 5 === 0 || i === totalFrames - 1) {
          const videoProgress = ((i + 1) / totalFrames) * (99 - startProgress);
          onProgress(startProgress + videoProgress);
          await yieldToEventLoop();
        }
      }

      this.throwIfCancelled();

      const renderHealth = this.collectRenderHealth(visualTracks);
      this.warnOnDegradedRenderHealth(renderHealth, "selection render");

      const { blobs: outputs, analyses: outputAnalyses, files, streamedOutputIds = [] } =
        await outputEncoder.finalize();
      const primaryOutputId = outputs.video
        ? "video"
        : (Object.keys(outputs)[0] ?? null);
      if (!primaryOutputId && Object.keys(files).length === 0 && streamedOutputIds.length === 0) {
        throw new Error("Renderer produced no video outputs");
      }

      return {
        video: primaryOutputId ? outputs[primaryOutputId] : undefined,
        files,
        ...(streamedOutputIds.length > 0 ? { streamedOutputIds } : {}),
        mask: outputs.mask,
        outputs,
        outputAnalyses,
        renderHealth,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.cancelController = null;
      await outputEncoder?.abort();
      outputEncoder?.dispose();
      this.outputEncoder = null;
      frameTexture?.destroy(true);
      this.dispose();
      frameGraphExecutor.dispose();
      decoderPool.dispose();
    }
  }

  public async renderStill(
    projectData: ProjectData,
    config: ExportConfig,
    requestedTick: number,
    options: RenderStillOptions = {},
  ): Promise<Blob> {
    const debugLog = this.debugLog;
    if (!debugLog) {
      return this.renderStillFrame(projectData, config, requestedTick, options);
    }
    return this.withDebugLog(debugLog, () =>
      this.renderStillFrame(projectData, config, requestedTick, options),
    );
  }

  private async withDebugLog<T>(
    debugLog: ExportDebugLog,
    run: () => Promise<T>,
  ): Promise<T> {
    this.renderStarted = true;
    try {
      const result = await run();
      debugLog.finish("completed");
      return result;
    } catch (error) {
      debugLog.finish(isAbortError(error) ? "cancelled" : "failed");
      throw error;
    }
  }

  private async renderStillFrame(
    projectData: ProjectData,
    config: ExportConfig,
    requestedTick: number,
    options: RenderStillOptions,
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

    const selection = options.timelineSelection
      ? convertLegacyTimelineSelection(options.timelineSelection, projectData.fps) : undefined;
    const tick = selection ? requestedTick - selection.anchor : requestedTick;
    const renderProjectData = options.timelineSelection
      ? buildSelectionProjectData(projectData, selection!)
      : projectData;
    const { assets, fps } = renderProjectData;
    const availableTracks = renderProjectData.tracks;
    const availableClips = renderProjectData.clips;
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
        renderProjectData.tracks,
        renderProjectData.clips,
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
      // Derivation reads the full render topology, including empty-container
      // behaviour for unregistered reach. See render() above.
      this.orchestrator.setAdjustmentSource(
        renderProjectData.tracks,
        renderProjectData.clips,
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
        renderProjectData.clips,
      );
      const temporalPlan = temporalCoordinator.plan({
        presentationTick: tick,
        fps,
        mode: "still",
        requirements: temporalScope.requirements,
        earliestTick: temporalScope.earliestTick,
        topologyKey: temporalScope.topologyKey,
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
          tracks: renderProjectData.tracks,
          clips: renderProjectData.clips,
          transitions: renderProjectData.transitions ?? [],
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
          composites: renderProjectData.composites,
          compositeSourcePolicy: renderProjectData.compositeSourcePolicy,
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
    if (this.isCancelled || this.outputEncoder?.isCommitting) return;
    this.isCancelled = true;
    this.cancelController?.abort();
    void this.outputEncoder?.abort();
    const abortError = createRenderAbortError();
    this.engines.forEach((engine) => engine.cancelPendingFrame(abortError));
  }

  public dispose() {
    // Rendering finishes its own log; this covers a renderer that never ran.
    if (!this.renderStarted) this.debugLog?.finish("cancelled");
    this.orchestrator?.dispose();
    this.orchestrator = null;
    this.engines.forEach((engine) => engine.dispose());
    this.engines = [];
    this.gpuContext.dispose();
    this.app.destroy(false, { children: true, texture: true });
  }

  private throwIfCancelled() {
    if (this.isCancelled || this.cancelController?.signal.aborted) {
      throw createRenderAbortError();
    }
  }
}
