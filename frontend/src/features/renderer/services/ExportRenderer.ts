import { Application, Container, RenderTexture } from "pixi.js";
import type {
  TimelineTrack,
  TimelineClip,
  MaskTimelineClip,
  TimelineSelection,
} from "../../../types/TimelineTypes";
import type { Asset } from "../../../types/Asset";
import { TICKS_PER_SECOND } from "../../timeline";
import { TrackRenderEngine } from "./TrackRenderEngine";
import { TrackAudioRenderer } from "./TrackAudioRenderer";
import {
  findActiveClipAtTicks,
  sortTrackClipsByStart,
} from "../utils/clipLookup";
import { getAssetInput } from "../../userAssets";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../../timelineSelection";
import {
  TextureOutputEncoder,
  type OutputVideoDefinition,
} from "./TextureOutputEncoder";

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
      const format = definition.format ?? fallbackFormat;
      return {
        ...definition,
        format,
        includeAudio: definition.includeAudio ?? index === 0,
        preserveAlpha:
          definition.preserveAlpha ?? (format === "webm" && index === 0),
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
      preserveAlpha: fallbackFormat === "webm",
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
  selectedClips: TimelineClip[],
  includeTimelineMasks: boolean,
): PreparedVisualRenderData {
  const trackClipsByTrackId = new Map(
    tracks.map((track) => [
      track.id,
      sortTrackClipsByStart(
        selectedClips.filter(
          (clip) => clip.trackId === track.id && clip.type !== "mask",
        ),
      ),
    ]),
  );

  const maskClipsByParent = new Map<string, MaskTimelineClip[]>();
  if (includeTimelineMasks) {
    const clipsById = new Map(selectedClips.map((clip) => [clip.id, clip] as const));
    for (const clip of selectedClips) {
      if (clip.type === "mask") continue;
      const maskChildIds = (clip.clipComponents ?? [])
        .filter((component) => component.componentType === "mask")
        .map((component) => component.clipId);
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
  format?: "mp4" | "webm";
  outputs?: OutputVideoDefinition[];
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
}

export interface RenderStillOptions {
  includeTimelineMasks?: boolean;
  signal?: AbortSignal;
  mimeType?: "image/png" | "image/webp";
  quality?: number;
}

export interface RenderResult {
  video: Blob;
  mask?: Blob;
  outputs: Record<string, Blob>;
}

export class ExportRenderer {
  private app: Application;
  private logicalStage: Container;
  private engines: TrackRenderEngine[] = [];
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
    const app = new Application();

    await app.init({
      width: outputWidth,
      height: outputHeight,
      backgroundColor: 0x000000,
      backgroundAlpha,
      antialias: true,
      resolution: 1,
      autoDensity: false,
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
    };
    const selectedClips = timelineSelection.clips;
    const startTick = timelineSelection.start;
    const inferredEndTick = selectedClips.reduce(
      (max, clip) => Math.max(max, clip.start + clip.timelineDuration),
      startTick,
    );
    const requestedEndTick = Math.max(
      startTick,
      timelineSelection.end ?? inferredEndTick,
    );
    const renderFps = resolveSelectionFps(timelineSelection, fps);
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
    const hasAudioOutput = outputDefinitions.some((output) => output.includeAudio);

    const { trackClipsByTrackId, maskClipsByParent, visualTracks } =
      buildVisualRenderData(
        tracks,
        selectedClips,
        options.includeTimelineMasks !== false,
      );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));

    const relevantForAudio = tracks.filter((t) => !t.isMuted);
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
      // --- AUDIO EXPORT LOOP ---
      const rangeDurationSec = rangeDurationTicks / TICKS_PER_SECOND;

      if (shouldRenderAudio) {
        const audioRenderers = relevantForAudio.map(
          (t) => new TrackAudioRenderer(t.id),
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
                    baseTicks: startTick + chunkStartSec * TICKS_PER_SECOND,
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

      this.engines = visualTracks.map((_, index) => {
        const zIndex = visualTracks.length - 1 - index;
        const engine = new TrackRenderEngine(zIndex, undefined, this.app.renderer);
        engine.addTo(this.logicalStage);
        return engine;
      });

      this.logicalStage.sortableChildren = true;
      this.logicalStage.sortChildren();

      for (let i = 0; i < totalFrames; i += 1) {
        this.throwIfCancelled();

        const currentTime = startTick + i * ticksPerFrame;
        const timestamp = i / renderFps; // Seconds relative to output start

        const promises: Promise<void>[] = [];

        visualTracks.forEach((track, index) => {
          const engine = this.engines[index];
          const trackClips = trackClipsByTrackId.get(track.id) || [];

          engine.update(
            currentTime,
            trackClips,
            maskClipsByParent,
            assets,
            { width: logicalWidth, height: logicalHeight },
            { shouldRender: false, fps: renderFps },
          );

          const activeClip = findActiveClipAtTicks(trackClips, currentTime);

          if (activeClip) {
            const activeMaskClips = maskClipsByParent.get(activeClip.id) ?? [];
            promises.push(
              engine.renderFrame(
                currentTime,
                activeClip,
                {
                  width: logicalWidth,
                  height: logicalHeight,
                },
                activeMaskClips,
                assetsById,
                {
                  fps: renderFps,
                  signal: this.cancelController?.signal,
                },
              ),
            );
          }
        });

        await Promise.all(promises);
        this.throwIfCancelled();

        // Render timeline frame once to an offscreen texture.
        this.app.renderer.render({
          container: this.logicalStage,
          target: frameTexture,
          clear: true,
        });

        // Encode one or more outputs by applying per-output transform stacks.
        await outputEncoder.addTextureFrame(frameTexture, timestamp, 1 / renderFps);

        this.throwIfCancelled();

        if (i % 5 === 0) {
          const videoProgress = (i / totalFrames) * (100 - startProgress);
          onProgress(startProgress + videoProgress);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      this.throwIfCancelled();

      const outputs = await outputEncoder.finalize();
      const primaryOutputId = outputs.video
        ? "video"
        : Object.keys(outputs)[0] ?? null;
      if (!primaryOutputId) {
        throw new Error("Renderer produced no video outputs");
      }

      return {
        video: outputs[primaryOutputId],
        mask: outputs.mask,
        outputs,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.cancelController = null;
      outputEncoder.dispose();
      frameTexture.destroy(true);
      this.dispose();
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
    if (options.signal?.aborted) {
      this.cancel();
      throw createRenderAbortError();
    }
    const onAbort = () => this.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const { tracks, clips, assets, fps } = projectData;
    const { logicalWidth, logicalHeight } = config;
    const { trackClipsByTrackId, maskClipsByParent, visualTracks } =
      buildVisualRenderData(
        tracks,
        clips,
        options.includeTimelineMasks !== false,
      );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));

    try {
      this.engines = visualTracks.map((_, index) => {
        const zIndex = visualTracks.length - 1 - index;
        const engine = new TrackRenderEngine(zIndex, undefined, this.app.renderer);
        engine.addTo(this.logicalStage);
        return engine;
      });

      this.logicalStage.sortableChildren = true;
      this.logicalStage.sortChildren();

      const promises: Promise<void>[] = [];

      visualTracks.forEach((track, index) => {
        const engine = this.engines[index];
        const trackClips = trackClipsByTrackId.get(track.id) || [];

        engine.update(
          tick,
          trackClips,
          maskClipsByParent,
          assets,
          { width: logicalWidth, height: logicalHeight },
          { shouldRender: false, fps },
        );

        const activeClip = findActiveClipAtTicks(trackClips, tick);
        if (!activeClip) return;

        const activeMaskClips = maskClipsByParent.get(activeClip.id) ?? [];
        promises.push(
          engine.renderFrame(
            tick,
            activeClip,
            {
              width: logicalWidth,
              height: logicalHeight,
            },
            activeMaskClips,
            assetsById,
            {
              fps,
              signal: this.cancelController?.signal,
            },
          ),
        );
      });

      await Promise.all(promises);
      this.throwIfCancelled();

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
    }
  }

  public cancel() {
    if (this.isCancelled) return;
    this.isCancelled = true;
    this.cancelController?.abort();
    const abortError = createRenderAbortError();
    this.engines.forEach((engine) => engine.cancelPendingFrame(abortError));
  }

  public dispose() {
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
