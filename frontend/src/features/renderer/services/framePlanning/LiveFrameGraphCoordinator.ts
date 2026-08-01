import type { Asset } from "../../../../types/Asset";
import type {
  CompositeAsset,
  MaskTimelineClip,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import type { Renderer, Texture } from "pixi.js";
import type { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import {
  BatchFrameGraphExecutor,
  isAbortError,
  type BatchFrameGraphExecutionResult,
} from "./BatchFrameGraphExecutor";
import { FrameJobResolver } from "./FrameJobResolver";
import { buildFrameResolutionGraph } from "./FrameResolutionGraph";
import { buildScenePresentationPlan } from "./ScenePresentationPlanner";
import type {
  FrameExecutionPolicy,
  FramePlanningDiagnostics,
  ResolvedClipFrameJob,
  ScenePresentationPlan,
} from "./framePlanningTypes";
import { resolveTransitionFrame } from "../../../transitions/rendering/TransitionResolver";
import { TemporalRenderCoordinator } from "../TemporalRenderCoordinator";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import { CompositeSceneRuntimeManager } from "../CompositeSceneRuntime";
import { collectTemporalFrameScope } from "../TemporalFrameScopeResolver";
import type { CompositeSourcePolicySnapshot } from "./CompositeSourcePolicy";

export interface LiveFrameGraphParticipant {
  trackId: string;
  engine: TrackRenderEngine;
  getTrackClips(): TimelineClip[];
  getMaskClipsByParent(): ReadonlyMap<string, MaskTimelineClip[]>;
  getAssets(): Asset[];
  onResolvedJob(job: ResolvedClipFrameJob | null): void;
}

export interface LiveFrameGraphRenderOptions {
  fps: number;
  logicalDimensions: { width: number; height: number };
  /** Physical output demand for live materialised scope results. */
  outputDimensions?: { width: number; height: number };
  visualTrackOrder: readonly string[];
  adjustmentEffectResolver: AdjustmentEffectResolver;
  tracks?: readonly TimelineTrack[];
  clips?: readonly TimelineClip[];
  transitions?: readonly Transition[];
  composites?: readonly CompositeAsset[];
  compositeSourcePolicy?: CompositeSourcePolicySnapshot;
  earliestTick?: number;
  /**
   * Approximate skips history replay for this live target only. The resulting
   * pixels are intentionally not timeline-faithful: retained state is
   * path-dependent and may contain activity originating after the requested
   * tick when scrubbing backwards. Never use this policy for still or export.
   */
  temporalPreviewQuality?: "exact" | "approximate";
  /** Cancels a superseded queue entry without changing frame-epoch identity. */
  signal?: AbortSignal;
  submitWarmupFrame?: (
    tick: number,
    plan: ScenePresentationPlan,
    render: FilterRenderContext,
  ) => void | Promise<void>;
}

export interface LiveFrameGraphRenderResult {
  presentationPlan: ScenePresentationPlan;
  execution: BatchFrameGraphExecutionResult;
  render: FilterRenderContext;
}

export interface LiveFrameGraphCoordinatorOptions {
  renderer?: Renderer;
  onCompositeSceneError?: (
    error: unknown,
    job: ResolvedClipFrameJob,
  ) => void;
  onCompositeSceneRendered?: (
    job: ResolvedClipFrameJob,
    texture: Texture,
  ) => void;
  onDiagnostics?: (
    diagnostics: FramePlanningDiagnostics,
    policy: FrameExecutionPolicy,
  ) => void;
}

/**
 * Shared live frame barrier. Every registered track resolves first, then one
 * graph shares source work across tracks and commits serial GPU work. Paused
 * edits request another epoch; unchanged resident source keys are leased from
 * the store without another decoder request.
 */
export class LiveFrameGraphCoordinator {
  private readonly participants = new Map<string, LiveFrameGraphParticipant>();
  private readonly requestListeners = new Set<(tick: number) => void>();
  private readonly resolver = new FrameJobResolver();
  private epoch = 0;
  private disposed = false;
  private readonly temporal = new TemporalRenderCoordinator();
  private readonly executor: BatchFrameGraphExecutor;

  constructor(options: LiveFrameGraphCoordinatorOptions = {}) {
    const isLiveEpochCurrent = (epoch: number) =>
      epoch === this.epoch && !this.disposed;
    this.executor = new BatchFrameGraphExecutor({
      isLiveEpochCurrent,
      ...(options.renderer
        ? {
            compositeSceneRenderer: new CompositeSceneRuntimeManager(
              options.renderer,
              undefined,
              { isLiveEpochCurrent },
            ),
          }
        : {}),
      onCompositeSceneError:
        options.onCompositeSceneError ??
        ((error, job) => {
          console.warn(
            `[CompositeScene] Direct render failed for '${job.activeClip.id}'; using a valid bake fallback when available.`,
            error,
          );
        }),
      onCompositeSceneRendered: options.onCompositeSceneRendered,
      ...(options.onDiagnostics
        ? { onDiagnostics: options.onDiagnostics }
        : {}),
    });
  }

  get participantCount(): number {
    return this.participants.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  register(participant: LiveFrameGraphParticipant): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.participants.set(participant.trackId, participant);
    return () => {
      if (this.participants.get(participant.trackId) === participant) {
        this.participants.delete(participant.trackId);
      }
    };
  }

  requestFrame(tick: number): void {
    // Enqueue a replacement frame without disturbing the in-flight epoch.
    // Frame execution is serialized by the Player's playback queue, so an
    // in-flight render always completes before its replacement starts; the
    // replacement (which re-resolves against current store state) then commits
    // over it. Bumping the epoch here instead races every concurrent
    // requestFrame from the per-track render effects against the live decode,
    // aborting otherwise-valid commits ("Stale live frame generation") and
    // leaving the canvas blank. Epoch ownership stays solely with renderFrame.
    for (const listener of this.requestListeners) {
      listener(tick);
    }
  }

  subscribeFrameRequests(listener: (tick: number) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async renderFrame(
    presentationTick: number,
    options: LiveFrameGraphRenderOptions,
  ): Promise<LiveFrameGraphRenderResult | null> {
    if (options.temporalPreviewQuality === "approximate") {
      // IMPORTANT — INTENTIONALLY UNFAITHFUL PREVIEW:
      // Match the responsive pre-history-scheduler path by retaining one
      // compatibility sequence and performing no temporal discovery/replay.
      // This is visually useful but path-dependent: a backward scrub can show
      // state produced by later source frames. Only paused interactive preview
      // may enter this branch; playback/exact requests rebuild, and still/export
      // use their deterministic renderers rather than this coordinator policy.
      const result = await this.renderSingleFrame(
        presentationTick,
        options,
        this.temporal.createApproximatePreviewContext(
          presentationTick,
          options.fps,
        ),
      );
      return result;
    }
    const participantTracks = [...this.participants.values()].map(
      (participant) => ({
        trackId: participant.trackId,
        trackClips: participant.getTrackClips(),
        activeClipResolver: participant.engine,
      }),
    );
    const temporalScope = collectTemporalFrameScope({
      presentationTick,
      tracks: participantTracks,
      stableClips: [
        ...participantTracks.flatMap((track) => track.trackClips),
        ...(options.clips ?? []).filter((clip) => clip.type === "adjustment"),
      ],
      adjustmentEffectResolver: options.adjustmentEffectResolver,
    });
    const temporalPlan = this.temporal.plan({
      presentationTick,
      fps: options.fps,
      mode: "preview",
      requirements: temporalScope.requirements,
      earliestTick: Math.max(
        options.earliestTick ?? 0,
        temporalScope.earliestTick,
      ),
      topologyKey: temporalScope.topologyKey,
    });

    for (const render of temporalPlan.warmup) {
      try {
        const result = await this.renderSingleFrame(
          render.presentationTimeTicks,
          options,
          render,
        );
        if (!result) {
          this.temporal.invalidate();
          return null;
        }
        await options.submitWarmupFrame?.(
          render.presentationTimeTicks,
          result.presentationPlan,
          render,
        );
      } catch (error) {
        this.temporal.invalidate();
        throw error;
      }
    }
    try {
      const result = await this.renderSingleFrame(
        presentationTick,
        options,
        temporalPlan.target,
      );
      if (!result) {
        this.temporal.invalidate();
      }
      return result;
    } catch (error) {
      this.temporal.invalidate();
      throw error;
    }
  }

  private async renderSingleFrame(
    presentationTick: number,
    options: LiveFrameGraphRenderOptions,
    render: FilterRenderContext,
  ): Promise<LiveFrameGraphRenderResult | null> {
    if (this.disposed) return null;
    this.epoch += 1;
    const epoch = this.epoch;
    const orderedParticipants = options.visualTrackOrder
      .map((trackId) => this.participants.get(trackId))
      .filter(
        (participant): participant is LiveFrameGraphParticipant =>
          !!participant,
      );
    const assets = orderedParticipants[0]?.getAssets() ?? [];
    const adjustmentForest =
      options.adjustmentEffectResolver.deriveGroups(presentationTick);
    const transitionFrame = resolveTransitionFrame({
      tracks: options.tracks ?? [],
      clips: options.clips ?? [],
      transitions: options.transitions ?? [],
      fps: options.fps,
      presentationTick,
      logicalDimensions: options.logicalDimensions,
      visualTrackOrder: options.visualTrackOrder,
      adjustmentForest,
    });
    const resolution = this.resolver.resolve({
      epoch,
      presentationTick,
      tracks: orderedParticipants.map((participant) => ({
        trackId: participant.trackId,
        engine: participant.engine,
        trackClips: participant.getTrackClips(),
        maskClipsByParent: participant.getMaskClipsByParent(),
      })),
      assets,
      composites: options.composites,
      compositeSourcePolicy: options.compositeSourcePolicy,
      logicalDimensions: options.logicalDimensions,
      fps: options.fps,
      transitionTransformsByClipId: transitionFrame.transformsByClipId,
    });
    const jobByTrackId = new Map(
      resolution.jobs.map((job) => [job.trackId, job] as const),
    );
    for (const participant of orderedParticipants) {
      participant.onResolvedJob(jobByTrackId.get(participant.trackId) ?? null);
    }

    const graph = buildFrameResolutionGraph(epoch, resolution.jobs);
    const presentationPlan = buildScenePresentationPlan({
      epoch,
      visualTrackOrder: options.visualTrackOrder,
      jobs: resolution.jobs,
      adjustmentForest,
      zIndexOverrides: transitionFrame.zIndexOverrides,
      transitionColorLayers: transitionFrame.colorLayers,
    });

    try {
      const execution = await this.executor.execute(graph, resolution, {
        mode: "live",
        epoch,
        signal: options.signal,
        render,
        temporalPreviewQuality:
          options.temporalPreviewQuality ?? "exact",
        ...(options.outputDimensions
          ? { outputDimensions: options.outputDimensions }
          : {}),
      });
      if (epoch !== this.epoch || this.disposed) {
        return null;
      }
      return { presentationPlan, execution, render };
    } catch (error) {
      if (isAbortError(error)) {
        return null;
      }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.participants.clear();
    this.requestListeners.clear();
    this.executor.dispose();
  }
}
