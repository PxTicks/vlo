import { Container, RenderTexture, type Renderer, type Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import {
  isCompositeClip,
  type MaskTimelineClip,
  type TimelineClip,
  type TimelineTrack,
  type Transition,
} from "../../../types/TimelineTypes";
import { resolveTransitionFrame } from "../../transitions/rendering/TransitionResolver";
import { namespaceCompositeRuntimeContent } from "../utils/compositeRuntimeNamespace";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import type { DecoderWorkerPool } from "./DecoderWorkerPool";
import { RenderGroupOrchestrator } from "./RenderGroupOrchestrator";
import { TrackRenderEngine } from "./TrackRenderEngine";
import { TemporalRenderCoordinator } from "./TemporalRenderCoordinator";
import { collectTemporalFrameScope } from "./TemporalFrameScopeResolver";
import {
  BatchFrameGraphExecutor,
  isAbortError,
  throwIfFrameExecutionCancelled,
  type BatchFrameGraphExecutorOptions,
} from "./framePlanning/BatchFrameGraphExecutor";
import {
  FrameJobResolver,
  type FrameJobResolutionTrack,
} from "./framePlanning/FrameJobResolver";
import { buildFrameResolutionGraph } from "./framePlanning/FrameResolutionGraph";
import { buildScenePresentationPlan } from "./framePlanning/ScenePresentationPlanner";
import type {
  CompositeChildPlanningDiagnostics,
  FrameExecutionPolicy,
  FramePlanningDiagnostics,
  FrameResourceLease,
  ResolvedCompositeSource,
} from "./framePlanning/framePlanningTypes";
import {
  createEmptyCompositeChildPlanningDiagnostics,
} from "./framePlanning/framePlanningTypes";
import type { FilterRenderContext } from "../../transformations/catalogue/types";
import { resolveCompositeRasterDimensionsForContent } from "../utils/compositeRasterDimensions";

export interface CompositeSceneFrameRenderer {
  renderCompositeScene(
    source: ResolvedCompositeSource,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<FrameResourceLease<Texture>>;
  getDiagnostics?(): CompositeSceneRuntimeDiagnostics;
  takeDiagnostics?(): CompositeSceneRuntimeDiagnostics;
  dispose(): void;
}

export interface CompositeSceneRuntimeDiagnostics {
  runtimeCount: number;
  pooledRuntimeCount: number;
  /** Bytes owned by the pool's output textures and charged to its budget. */
  outputTextureBytes: number;
  /** Total output and child-source texture bytes retained by the runtimes. */
  textureBytes: number;
  outstandingLeases: number;
  renderDedupHits: number;
  childPlanning: CompositeChildPlanningDiagnostics;
  childResidentSourceResources: number;
  childResidentSourceTextureBytes: number;
  childOutstandingLeases: number;
}

export interface CompositeSceneRuntimeManagerOptions {
  maxRuntimeCount?: number;
  /** Budget for pool-owned output textures; child-source bytes remain observable. */
  maxTextureBytes?: number;
  isLiveEpochCurrent?: (epoch: number) => boolean;
}

export const DEFAULT_COMPOSITE_RUNTIME_LIMIT = 12;
export const DEFAULT_COMPOSITE_TEXTURE_BUDGET_BYTES = 96 * 1024 * 1024;

interface RuntimeIdentity {
  revision: number;
  bakeKey: string;
  logicalWidth: number;
  logicalHeight: number;
  width: number;
  height: number;
  fps: number;
}

function identityFor(
  source: ResolvedCompositeSource,
  rasterDimensions: { width: number; height: number },
): RuntimeIdentity {
  return {
    revision: source.revision,
    bakeKey: source.bakeKey,
    logicalWidth: source.logicalDimensions.width,
    logicalHeight: source.logicalDimensions.height,
    width: rasterDimensions.width,
    height: rasterDimensions.height,
    fps: source.fps,
  };
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.revision === right.revision &&
    left.bakeKey === right.bakeKey &&
    left.logicalWidth === right.logicalWidth &&
    left.logicalHeight === right.logicalHeight &&
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps
  );
}

async function resolveSourceRasterDimensions(
  source: ResolvedCompositeSource,
  assets: readonly Asset[],
): Promise<{ width: number; height: number }> {
  return resolveCompositeRasterDimensionsForContent(
    source.content,
    assets,
    source.logicalDimensions,
  );
}

function buildMaskLookup(clips: readonly TimelineClip[]) {
  const clipsById = new Map(clips.map((clip) => [clip.id, clip] as const));
  const result = new Map<string, MaskTimelineClip[]>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    const masks = (clip.components ?? [])
      .filter((component) => component.type === "mask_ref")
      .map((component) => clipsById.get(component.parameters.maskClipId))
      .filter((candidate): candidate is MaskTimelineClip =>
        candidate?.type === "mask",
      );
    if (masks.length > 0) {
      result.set(clip.id, masks);
    }
  }
  return result;
}

function withRenderContext(
  policy: FrameExecutionPolicy,
  render: FilterRenderContext,
): FrameExecutionPolicy {
  return policy.mode === "export"
    ? { ...policy, render }
    : { ...policy, render };
}

function mergeChildPlanningDiagnostics(
  target: CompositeChildPlanningDiagnostics,
  source: CompositeChildPlanningDiagnostics,
): void {
  target.samples += source.samples;
  target.warmupSamples += source.warmupSamples;
  target.targetSamples += source.targetSamples;
  target.cancelledSamples += source.cancelledSamples;
  target.failedSamples += source.failedSamples;
  target.jobsPlanned += source.jobsPlanned;
  target.nodesPlanned += source.nodesPlanned;
  target.withinFrameDedupHits += source.withinFrameDedupHits;
  target.cacheHits += source.cacheHits;
  target.cacheMisses += source.cacheMisses;
  target.resolutionTimeMs += source.resolutionTimeMs;
  target.decodeTimeMs += source.decodeTimeMs;
  target.gpuTimeMs += source.gpuTimeMs;
  target.peakResidentSourceResources = Math.max(
    target.peakResidentSourceResources,
    source.peakResidentSourceResources,
  );
  target.peakResidentSourceTextureBytes = Math.max(
    target.peakResidentSourceTextureBytes,
    source.peakResidentSourceTextureBytes,
  );
  target.peakOutstandingLeases = Math.max(
    target.peakOutstandingLeases,
    source.peakOutstandingLeases,
  );
}

class CompositePlacementRuntime {
  private readonly root = new Container();
  private readonly output: RenderTexture;
  private readonly resolver = new FrameJobResolver();
  private readonly executor: BatchFrameGraphExecutor;
  private readonly adjustmentResolver = new AdjustmentEffectResolver();
  private readonly orchestrator: RenderGroupOrchestrator;
  private readonly engines: TrackRenderEngine[];
  private readonly resolutionTracks: FrameJobResolutionTrack[];
  private readonly visualTrackOrder: string[];
  private readonly tracks: TimelineTrack[];
  private readonly clips: TimelineClip[];
  private readonly transitions: Transition[];
  private readonly renderer: Renderer;
  private readonly source: ResolvedCompositeSource;
  private readonly temporal = new TemporalRenderCoordinator();
  private pendingDiagnostics = createEmptyCompositeChildPlanningDiagnostics();
  private epoch = 0;

  constructor(
    renderer: Renderer,
    source: ResolvedCompositeSource,
    identity: RuntimeIdentity,
    decoderPool?: DecoderWorkerPool,
    executorOptions: BatchFrameGraphExecutorOptions = {},
  ) {
    this.renderer = renderer;
    this.source = source;
    const externalDiagnostics = executorOptions.onDiagnostics;
    this.executor = new BatchFrameGraphExecutor({
      ...executorOptions,
      publishDiagnostics: false,
      onDiagnostics: (diagnostics, policy) => {
        this.recordDiagnostics(diagnostics, policy);
        externalDiagnostics?.(diagnostics, policy);
      },
    });
    if (source.content.clips.some((clip) => isCompositeClip(clip))) {
      throw new Error(
        `Nested composite content is not supported for '${source.compositeId}'.`,
      );
    }
    const content = namespaceCompositeRuntimeContent(
      source.content,
      source.placementId,
    );
    this.tracks = content.tracks;
    this.clips = content.clips;
    this.transitions = content.transitions;
    this.root.sortableChildren = true;
    this.output = RenderTexture.create({
      width: Math.max(1, identity.width),
      height: Math.max(1, identity.height),
      dynamic: true,
    });
    this.root.scale.set(
      identity.width / Math.max(1, identity.logicalWidth),
      identity.height / Math.max(1, identity.logicalHeight),
    );
    this.adjustmentResolver.setAdjustmentSource(
      this.tracks,
      this.clips,
      identity.fps,
    );
    this.orchestrator = new RenderGroupOrchestrator(this.root, {
      logicalDimensions: source.logicalDimensions,
      adjustmentEffectResolver: this.adjustmentResolver,
    });
    const visualTracks = this.tracks.filter(
      (track) => track.type === "visual" && track.isVisible,
    );
    this.visualTrackOrder = visualTracks.map((track) => track.id);
    const maskClipsByParent = buildMaskLookup(this.clips);
    this.engines = visualTracks.map((track, index) => {
      const engine = new TrackRenderEngine(
        visualTracks.length - 1 - index,
        undefined,
        renderer,
        {
          trackId: track.id,
          adjustmentEffectResolver: this.adjustmentResolver,
          ...(decoderPool ? { decoderPool } : {}),
        },
      );
      this.orchestrator.registerTrack(track.id, engine.container);
      return engine;
    });
    this.resolutionTracks = visualTracks.map((track, index) => ({
      trackId: track.id,
      engine: this.engines[index],
      trackClips: sortTrackClipsByStart(
        this.clips.filter(
          (clip) => clip.trackId === track.id && clip.type !== "mask",
        ),
      ),
      maskClipsByParent,
    }));
  }

  async render(
    localPresentationTick: number,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<Texture> {
    const temporalScope = collectTemporalFrameScope({
      presentationTick: localPresentationTick,
      tracks: this.resolutionTracks.map((track) => ({
        trackId: track.trackId,
        trackClips: track.trackClips,
        activeClipResolver: track.engine,
      })),
      stableClips: this.clips,
      adjustmentEffectResolver: this.adjustmentResolver,
    });
    const temporalPlan =
      policy.mode === "live" &&
      policy.temporalPreviewQuality === "approximate"
        ? {
            warmup: [],
            target: this.temporal.createApproximatePreviewContext(
              localPresentationTick,
              this.source.fps,
            ),
            isDiscontinuous: true,
          }
        : this.temporal.plan({
            presentationTick: localPresentationTick,
            fps: this.source.fps,
            mode:
              policy.render?.mode ??
              (policy.mode === "export" ? "export" : "preview"),
            requirements: temporalScope.requirements,
            earliestTick: temporalScope.earliestTick,
            topologyKey: temporalScope.topologyKey,
          });

    try {
      for (const warmup of temporalPlan.warmup) {
        await this.renderFrame(
          warmup.presentationTimeTicks,
          assets,
          withRenderContext(policy, warmup),
        );
      }
      await this.renderFrame(
        localPresentationTick,
        assets,
        withRenderContext(policy, temporalPlan.target),
      );
      return this.output;
    } catch (error) {
      this.temporal.invalidate();
      throw error;
    }
  }

  private async renderFrame(
    localPresentationTick: number,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<void> {
    this.epoch += 1;
    const adjustmentForest =
      this.adjustmentResolver.deriveGroups(localPresentationTick);
    const transitionFrame = resolveTransitionFrame({
      tracks: this.tracks,
      clips: this.clips,
      transitions: this.transitions,
      fps: this.source.fps,
      presentationTick: localPresentationTick,
      logicalDimensions: this.source.logicalDimensions,
      visualTrackOrder: this.visualTrackOrder,
      adjustmentForest,
    });
    const resolution = this.resolver.resolve({
      epoch: this.epoch,
      presentationTick: localPresentationTick,
      tracks: this.resolutionTracks,
      assets,
      composites: [],
      logicalDimensions: this.source.logicalDimensions,
      fps: this.source.fps,
      transitionTransformsByClipId: transitionFrame.transformsByClipId,
    });
    const graph = buildFrameResolutionGraph(this.epoch, resolution.jobs);
    const presentationPlan = buildScenePresentationPlan({
      epoch: this.epoch,
      visualTrackOrder: this.visualTrackOrder,
      jobs: resolution.jobs,
      adjustmentForest,
      zIndexOverrides: transitionFrame.zIndexOverrides,
      transitionColorLayers: transitionFrame.colorLayers,
    });
    try {
      await this.executor.execute(graph, resolution, policy);
    } catch (error) {
      if (isAbortError(error)) {
        this.pendingDiagnostics.cancelledSamples += 1;
      } else {
        this.pendingDiagnostics.failedSamples += 1;
      }
      throw error;
    }
    this.orchestrator.syncPresentationPlan(
      localPresentationTick,
      presentationPlan,
      policy.render,
    );
    this.renderer.render({
      container: this.root,
      target: this.output,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  }

  private recordDiagnostics(
    diagnostics: FramePlanningDiagnostics,
    policy: FrameExecutionPolicy,
  ): void {
    this.pendingDiagnostics.samples += 1;
    if (policy.render?.isWarmup) {
      this.pendingDiagnostics.warmupSamples += 1;
    } else {
      this.pendingDiagnostics.targetSamples += 1;
    }
    this.pendingDiagnostics.jobsPlanned += diagnostics.jobsPlanned;
    this.pendingDiagnostics.nodesPlanned += diagnostics.nodesPlanned;
    this.pendingDiagnostics.withinFrameDedupHits +=
      diagnostics.withinFrameDedupHits;
    this.pendingDiagnostics.cacheHits += diagnostics.cacheHits;
    this.pendingDiagnostics.cacheMisses += diagnostics.cacheMisses;
    this.pendingDiagnostics.resolutionTimeMs += diagnostics.resolutionTimeMs;
    this.pendingDiagnostics.decodeTimeMs += diagnostics.decodeTimeMs;
    this.pendingDiagnostics.gpuTimeMs += diagnostics.gpuTimeMs;
    this.pendingDiagnostics.peakResidentSourceResources = Math.max(
      this.pendingDiagnostics.peakResidentSourceResources,
      diagnostics.residentSourceResources,
    );
    this.pendingDiagnostics.peakResidentSourceTextureBytes = Math.max(
      this.pendingDiagnostics.peakResidentSourceTextureBytes,
      diagnostics.residentSourceTextureBytes,
    );
    this.pendingDiagnostics.peakOutstandingLeases = Math.max(
      this.pendingDiagnostics.peakOutstandingLeases,
      diagnostics.outstandingLeases,
    );
  }

  takePendingDiagnostics(): CompositeChildPlanningDiagnostics {
    const diagnostics = this.pendingDiagnostics;
    this.pendingDiagnostics = createEmptyCompositeChildPlanningDiagnostics();
    return diagnostics;
  }

  getResourceDiagnostics(): {
    residentSourceResources: number;
    residentSourceTextureBytes: number;
    outstandingSourceLeases: number;
  } {
    const diagnostics = this.executor.getResourceDiagnostics();
    return {
      residentSourceResources: diagnostics.residentSourceResources,
      residentSourceTextureBytes: diagnostics.residentSourceTextureBytes,
      outstandingSourceLeases: diagnostics.outstandingLeases,
    };
  }

  dispose(): void {
    this.executor.dispose();
    this.orchestrator.dispose();
    this.engines.forEach((engine) => engine.dispose());
    this.output.destroy(true);
    if (!this.root.destroyed) {
      this.root.destroy({ children: true });
    }
  }
}

interface CompositeRuntimeEntry {
  key: string;
  identity: RuntimeIdentity;
  runtime: CompositePlacementRuntime;
  outputTextureBytes: number;
  lastUsed: number;
  leaseCount: number;
  lastRenderedWorkKey: string | null;
  lastTexture: Texture | null;
  disposed: boolean;
}

function runtimePoolKey(source: ResolvedCompositeSource): string {
  if (!source.isStateless) return `placement:${source.placementId}`;
  return [
    "stateless",
    source.compositeId,
    source.revision,
    source.bakeKey,
    source.localPresentationTick,
    source.logicalDimensions.width,
    source.logicalDimensions.height,
    source.fps,
  ].join(":");
}

function renderWorkKey(
  source: ResolvedCompositeSource,
  identity: RuntimeIdentity,
): string {
  return JSON.stringify([
    source.compositeId,
    source.revision,
    source.bakeKey,
    source.isStateless ? "stateless" : source.placementId,
    source.localPresentationTick,
    identity.logicalWidth,
    identity.logicalHeight,
    identity.width,
    identity.height,
    identity.fps,
  ]);
}

/**
 * Pools child-scene runtimes behind reference-counted frame leases. Stateless
 * placements may share a complete work key; temporal placements always retain
 * placement-private history. Inactive entries are held only within explicit
 * count and texture-memory budgets.
 */
export class CompositeSceneRuntimeManager
  implements CompositeSceneFrameRenderer
{
  private readonly runtimes = new Map<
    string,
    CompositeRuntimeEntry
  >();
  private readonly allEntries = new Set<CompositeRuntimeEntry>();
  private readonly renderer: Renderer;
  private readonly decoderPool?: DecoderWorkerPool;
  private readonly maxRuntimeCount: number;
  private readonly maxTextureBytes: number;
  private readonly isLiveEpochCurrent?: (epoch: number) => boolean;
  private readonly rasterDimensionsByIdentity = new Map<
    string,
    Promise<{ width: number; height: number }>
  >();
  private useCounter = 0;
  private renderDedupHits = 0;
  private pendingChildDiagnostics =
    createEmptyCompositeChildPlanningDiagnostics();
  private disposed = false;

  constructor(
    renderer: Renderer,
    decoderPool?: DecoderWorkerPool,
    options: CompositeSceneRuntimeManagerOptions = {},
  ) {
    this.renderer = renderer;
    this.decoderPool = decoderPool;
    this.isLiveEpochCurrent = options.isLiveEpochCurrent;
    this.maxRuntimeCount = Math.max(
      1,
      Math.floor(options.maxRuntimeCount ?? DEFAULT_COMPOSITE_RUNTIME_LIMIT),
    );
    this.maxTextureBytes = Math.max(
      4,
      Math.floor(
        options.maxTextureBytes ?? DEFAULT_COMPOSITE_TEXTURE_BUDGET_BYTES,
      ),
    );
  }

  async renderCompositeScene(
    source: ResolvedCompositeSource,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<FrameResourceLease<Texture>> {
    if (this.disposed) {
      throw new Error("Composite scene runtime manager has been disposed");
    }
    this.throwIfCancelled(policy);
    const rasterIdentity = `${source.compositeId}:${source.revision}:${source.bakeKey}`;
    let rasterDimensions = this.rasterDimensionsByIdentity.get(rasterIdentity);
    if (!rasterDimensions) {
      rasterDimensions = resolveSourceRasterDimensions(source, assets);
      this.rasterDimensionsByIdentity.set(rasterIdentity, rasterDimensions);
    }
    const identity = identityFor(source, await rasterDimensions);
    this.throwIfCancelled(policy);
    const key = runtimePoolKey(source);
    let entry = this.runtimes.get(key);
    if (!entry || !sameIdentity(entry.identity, identity)) {
      if (entry) this.retireEntry(entry);
      entry = {
        key,
        identity,
        runtime: new CompositePlacementRuntime(
          this.renderer,
          source,
          identity,
          this.decoderPool,
          {
            ...(this.isLiveEpochCurrent
              ? { isLiveEpochCurrent: this.isLiveEpochCurrent }
              : {}),
          },
        ),
        outputTextureBytes: identity.width * identity.height * 4,
        lastUsed: ++this.useCounter,
        leaseCount: 0,
        lastRenderedWorkKey: null,
        lastTexture: null,
        disposed: false,
      };
      this.runtimes.set(key, entry);
      this.allEntries.add(entry);
    }
    entry.lastUsed = ++this.useCounter;
    const workKey = renderWorkKey(source, identity);
    let texture = entry.lastTexture;
    if (
      source.isStateless &&
      entry.lastRenderedWorkKey === workKey &&
      texture
    ) {
      this.renderDedupHits += 1;
    } else {
      try {
        texture = await entry.runtime.render(
          source.localPresentationTick,
          assets,
          policy,
        );
      } catch (error) {
        if (isAbortError(error)) {
          // A cancelled temporal replay may have advanced only part of the
          // placement-private filter state. Remove it from the active pool so
          // the replacement request starts with fresh engines and history.
          this.retireEntry(entry);
        }
        throw error;
      } finally {
        mergeChildPlanningDiagnostics(
          this.pendingChildDiagnostics,
          entry.runtime.takePendingDiagnostics(),
        );
      }
      entry.lastRenderedWorkKey = workKey;
      entry.lastTexture = texture;
    }
    if (!texture) {
      throw new Error("Composite scene did not produce an output texture");
    }

    entry.leaseCount += 1;
    this.enforceBudget(entry);
    let released = false;
    return {
      key: workKey,
      value: texture,
      release: () => {
        if (released) return;
        released = true;
        entry!.leaseCount = Math.max(0, entry!.leaseCount - 1);
        if (this.runtimes.get(entry!.key) !== entry) {
          this.disposeEntryIfUnleased(entry!);
        }
        this.enforceBudget();
      },
    };
  }

  getDiagnostics(): CompositeSceneRuntimeDiagnostics {
    let outputTextureBytes = 0;
    let textureBytes = 0;
    let outstandingLeases = 0;
    let pooledRuntimeCount = 0;
    let childResidentSourceResources = 0;
    let childResidentSourceTextureBytes = 0;
    let childOutstandingLeases = 0;
    for (const entry of this.allEntries) {
      if (entry.disposed) continue;
      const childResources = entry.runtime.getResourceDiagnostics();
      outputTextureBytes += entry.outputTextureBytes;
      textureBytes +=
        entry.outputTextureBytes +
        childResources.residentSourceTextureBytes;
      outstandingLeases += entry.leaseCount;
      childResidentSourceResources += childResources.residentSourceResources;
      childResidentSourceTextureBytes +=
        childResources.residentSourceTextureBytes;
      childOutstandingLeases += childResources.outstandingSourceLeases;
      if (entry.leaseCount === 0) pooledRuntimeCount += 1;
    }
    return {
      runtimeCount: this.allEntries.size,
      pooledRuntimeCount,
      outputTextureBytes,
      textureBytes,
      outstandingLeases,
      renderDedupHits: this.renderDedupHits,
      childPlanning: { ...this.pendingChildDiagnostics },
      childResidentSourceResources,
      childResidentSourceTextureBytes,
      childOutstandingLeases,
    };
  }

  takeDiagnostics(): CompositeSceneRuntimeDiagnostics {
    const diagnostics = this.getDiagnostics();
    this.pendingChildDiagnostics =
      createEmptyCompositeChildPlanningDiagnostics();
    return diagnostics;
  }

  private throwIfCancelled(policy: FrameExecutionPolicy): void {
    try {
      throwIfFrameExecutionCancelled(policy, this.isLiveEpochCurrent);
    } catch (error) {
      if (isAbortError(error)) {
        this.pendingChildDiagnostics.cancelledSamples += 1;
      }
      throw error;
    }
  }

  private enforceBudget(protectedEntry?: CompositeRuntimeEntry): void {
    const getResident = () =>
      [...this.allEntries].filter((entry) => !entry.disposed);
    let resident = getResident();
    // The output budget and runtime-count cap were calibrated together. Child
    // source textures are reported in diagnostics, but charging them here
    // would silently reduce the pool from roughly twelve 1080p outputs to
    // about three ordinary multi-track composites.
    let bytes = resident.reduce(
      (sum, entry) => sum + entry.outputTextureBytes,
      0,
    );
    while (
      resident.length > this.maxRuntimeCount ||
      bytes > this.maxTextureBytes
    ) {
      const candidate = resident
        .filter(
          (entry) => entry !== protectedEntry && entry.leaseCount === 0,
        )
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!candidate) break;
      if (this.runtimes.get(candidate.key) === candidate) {
        this.runtimes.delete(candidate.key);
      }
      this.disposeEntry(candidate);
      resident = getResident();
      bytes = resident.reduce(
        (sum, entry) => sum + entry.outputTextureBytes,
        0,
      );
    }
  }

  private retireEntry(entry: CompositeRuntimeEntry): void {
    if (this.runtimes.get(entry.key) === entry) {
      this.runtimes.delete(entry.key);
    }
    this.disposeEntryIfUnleased(entry);
  }

  private disposeEntryIfUnleased(entry: CompositeRuntimeEntry): void {
    if (entry.leaseCount === 0) this.disposeEntry(entry);
  }

  private disposeEntry(entry: CompositeRuntimeEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.runtime.dispose();
    this.allEntries.delete(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.allEntries]) {
      this.disposeEntry(entry);
    }
    this.runtimes.clear();
    this.rasterDimensionsByIdentity.clear();
  }
}
