import type { Asset } from "../../../../types/Asset";
import type {
  MaskTimelineClip,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import type { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";
import type { TrackRenderEngine } from "../TrackRenderEngine";
import {
  BatchFrameGraphExecutor,
  type BatchFrameGraphExecutionResult,
} from "./BatchFrameGraphExecutor";
import { FrameJobResolver } from "./FrameJobResolver";
import { buildFrameResolutionGraph } from "./FrameResolutionGraph";
import { buildScenePresentationPlan } from "./ScenePresentationPlanner";
import type {
  ResolvedClipFrameJob,
  ScenePresentationPlan,
} from "./framePlanningTypes";
import { resolveTransitionFrame } from "../../../transitions/rendering/TransitionResolver";

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
  visualTrackOrder: readonly string[];
  adjustmentEffectResolver: AdjustmentEffectResolver;
  tracks?: readonly TimelineTrack[];
  clips?: readonly TimelineClip[];
  transitions?: readonly Transition[];
}

export interface LiveFrameGraphRenderResult {
  presentationPlan: ScenePresentationPlan;
  execution: BatchFrameGraphExecutionResult;
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
  private readonly executor = new BatchFrameGraphExecutor({
    isLiveEpochCurrent: (epoch) => epoch === this.epoch && !this.disposed,
  });

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
      });
      if (epoch !== this.epoch || this.disposed) {
        return null;
      }
      return { presentationPlan, execution };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
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
