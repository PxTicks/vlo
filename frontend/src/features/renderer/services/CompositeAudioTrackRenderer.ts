import type { Input } from "mediabunny";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { mediaSecondsToTickExact } from "../utils/mediaTime";
import type { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import {
  createCompositeAudioTrackPlan,
  type CompositeAudioSourceData,
  type DirectCompositeAudioPlacementPlan,
} from "./CompositeAudioResolver";
import {
  createClipCurveEvaluators,
  TrackAudioRenderer,
} from "./TrackAudioRenderer";
import {
  buildAudioEffectChain,
  getAudioEffectTransforms,
  type AudioEffectChain,
} from "./audioEffectChain";

const REALTIME_PARENT_CURVE_SAMPLE_COUNT = 64;
const OFFLINE_PARENT_CURVE_SAMPLE_COUNT = 256;

function isRealtimeContext(ctx: BaseAudioContext): boolean {
  return (
    typeof OfflineAudioContext === "undefined" ||
    !(ctx instanceof OfflineAudioContext)
  );
}

interface CompositeAudioGraph {
  ctx: BaseAudioContext;
  destination: AudioNode;
  mixNode: GainNode;
  parentGain: GainNode;
  parentEffects: AudioEffectChain | null;
}

class DirectCompositeAudioRuntime {
  private readonly childRenderers: TrackAudioRenderer[];
  private readonly plan: DirectCompositeAudioPlacementPlan;
  private graph: CompositeAudioGraph | null = null;
  private nextParentAutomationTime = 0;

  constructor(
    plan: DirectCompositeAudioPlacementPlan,
    resetContextTime: number | null,
  ) {
    this.plan = plan;
    this.childRenderers = plan.lanes.map(
      (lane) => new TrackAudioRenderer(lane.id, null, lane.timingResolver),
    );
    if (resetContextTime !== null) {
      this.reset(resetContextTime);
    }
  }

  getNextScheduleTime(): number {
    if (this.childRenderers.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(
      ...this.childRenderers.map((renderer) => renderer.getNextScheduleTime()),
    );
  }

  getPlacementId(): string {
    return this.plan.parentClip.id;
  }

  reset(contextTime: number): void {
    this.disposeGraph();
    this.nextParentAutomationTime = contextTime + 0.15;
    for (const renderer of this.childRenderers) {
      renderer.reset(contextTime);
    }
  }

  stop(): void {
    for (const renderer of this.childRenderers) renderer.stop();
    this.disposeGraph();
  }

  dispose(): void {
    for (const renderer of this.childRenderers) renderer.dispose();
    this.disposeGraph();
  }

  async process(
    ctx: BaseAudioContext,
    destination: AudioNode,
    getInput: (assetId: string) => Promise<Input | null>,
    timeMapping: { baseTicks: number; baseContextTime: number },
    options: { lookahead: number; forceFlush?: boolean },
  ): Promise<void> {
    if (
      ("isMuted" in this.plan.parentClip && this.plan.parentClip.isMuted) ||
      this.childRenderers.length === 0
    ) {
      return;
    }

    const graph = this.ensureGraph(ctx, destination);
    this.scheduleParentOperations(ctx, graph, timeMapping, options.lookahead);

    await Promise.all(
      this.childRenderers.map((renderer, index) =>
        renderer.process(
          ctx,
          graph.mixNode,
          this.plan.lanes[index].clips,
          getInput,
          timeMapping,
          options,
        ),
      ),
    );
  }

  private ensureGraph(
    ctx: BaseAudioContext,
    destination: AudioNode,
  ): CompositeAudioGraph {
    if (
      this.graph?.ctx === ctx &&
      this.graph.destination === destination
    ) {
      return this.graph;
    }

    this.disposeGraph();
    const mixNode = ctx.createGain();
    const parentGain = ctx.createGain();
    mixNode.connect(parentGain);

    const parentTransforms = getAudioEffectTransforms(this.plan.parentClip);
    const parentEffects = buildAudioEffectChain(ctx, parentTransforms);
    if (parentEffects) {
      parentGain.connect(parentEffects.inputNode);
      parentEffects.outputNode.connect(destination);
    } else {
      parentGain.connect(destination);
    }

    this.graph = {
      ctx,
      destination,
      mixNode,
      parentGain,
      parentEffects,
    };
    return this.graph;
  }

  private scheduleParentOperations(
    ctx: BaseAudioContext,
    graph: CompositeAudioGraph,
    timeMapping: { baseTicks: number; baseContextTime: number },
    lookahead: number,
  ): void {
    const startContextTime = Math.max(
      ctx.currentTime,
      this.nextParentAutomationTime,
    );
    const endContextTime = ctx.currentTime + lookahead;
    if (endContextTime <= startContextTime) return;

    const wallDurationSeconds = endContextTime - startContextTime;
    const startTargetTicks =
      timeMapping.baseTicks +
      mediaSecondsToTickExact(
        startContextTime - timeMapping.baseContextTime,
      );
    const windowTicks = mediaSecondsToTickExact(wallDurationSeconds);
    const sampleCount = isRealtimeContext(ctx)
      ? REALTIME_PARENT_CURVE_SAMPLE_COUNT
      : OFFLINE_PARENT_CURVE_SAMPLE_COUNT;
    const curves = createClipCurveEvaluators(this.plan.parentClip);

    if (curves.constantVolumeGain !== null) {
      graph.parentGain.gain.setValueAtTime(
        Math.max(0, curves.constantVolumeGain),
        startContextTime,
      );
    } else {
      const volumeCurve = new Float32Array(sampleCount);
      const step = windowTicks / Math.max(1, sampleCount - 1);
      for (let index = 0; index < sampleCount; index += 1) {
        const presentationTick = startTargetTicks + index * step;
        volumeCurve[index] = this.plan.parentTiming.isActiveAt(presentationTick)
          ? curves.evaluateVolume(
              this.plan.parentTiming.sourceTicksAt(presentationTick),
            )
          : 0;
      }
      try {
        graph.parentGain.gain.setValueCurveAtTime(
          volumeCurve,
          startContextTime,
          wallDurationSeconds,
        );
      } catch {
        graph.parentGain.gain.setValueAtTime(
          volumeCurve[0],
          startContextTime,
        );
      }
    }

    if (graph.parentEffects) {
      graph.parentEffects.scheduleAutomation(
        {
          startContextTime,
          wallDurationSeconds,
          startTargetTicks,
          windowTicks,
          sampleCount,
          sourceTimeTicksAt: (presentationTick) =>
            this.plan.parentTiming.sourceTicksAt(presentationTick),
        },
        getAudioEffectTransforms(this.plan.parentClip),
      );
    }

    this.nextParentAutomationTime = endContextTime;
  }

  private disposeGraph(): void {
    if (!this.graph) return;
    this.graph.parentEffects?.dispose();
    try {
      this.graph.mixNode.disconnect();
      this.graph.parentGain.disconnect();
    } catch {
      // The nodes may already have been disconnected by context teardown.
    }
    this.graph = null;
  }
}

/**
 * Audio scheduler shared by preview and export. Composite source choices are
 * captured at reset/first process and remain pinned until the next transport
 * boundary, while ordinary clips continue through TrackAudioRenderer.
 */
export class CompositeAudioTrackRenderer {
  public readonly trackId: string;
  private readonly mainRenderer: TrackAudioRenderer;
  private pendingSourceData: CompositeAudioSourceData | null;
  private activeSourceData: CompositeAudioSourceData | null = null;
  private plan: ReturnType<typeof createCompositeAudioTrackPlan> | null = null;
  private directRuntimes: DirectCompositeAudioRuntime[] = [];
  private resetContextTime: number | null = null;

  constructor(
    trackId: string,
    adjustmentEffectResolver?: AdjustmentEffectResolver | null,
    sourceData?: CompositeAudioSourceData | null,
  ) {
    this.trackId = trackId;
    this.mainRenderer = new TrackAudioRenderer(
      trackId,
      adjustmentEffectResolver,
    );
    this.pendingSourceData = sourceData ?? null;
  }

  setCompositeSourceData(sourceData: CompositeAudioSourceData | null): void {
    this.pendingSourceData = sourceData;
  }

  getNextScheduleTime(): number {
    return Math.min(
      this.mainRenderer.getNextScheduleTime(),
      ...this.directRuntimes.map((runtime) => runtime.getNextScheduleTime()),
    );
  }

  reset(contextTime: number): void {
    this.disposeDirectRuntimes();
    this.plan = null;
    this.activeSourceData = null;
    this.resetContextTime = contextTime;
    this.mainRenderer.reset(contextTime);
  }

  stop(): void {
    this.mainRenderer.stop();
    for (const runtime of this.directRuntimes) runtime.stop();
  }

  dispose(): void {
    this.mainRenderer.dispose();
    this.disposeDirectRuntimes();
    this.plan = null;
    this.activeSourceData = null;
  }

  async process(
    ctx: BaseAudioContext,
    destination: AudioNode,
    trackClips: TimelineClip[],
    getInput: (assetId: string) => Promise<Input | null>,
    timeMapping: { baseTicks: number; baseContextTime: number },
    options: { lookahead: number; forceFlush?: boolean },
  ): Promise<void> {
    this.ensurePlan(trackClips);
    const plan = this.plan;
    if (!plan) {
      await this.mainRenderer.process(
        ctx,
        destination,
        trackClips,
        getInput,
        timeMapping,
        options,
      );
      return;
    }

    const compositeClipIds = new Set(
      this.activeSourceData?.clips
        .filter((clip) => clip.trackId === this.trackId && "compositeId" in clip)
        .map((clip) => clip.id) ?? [],
    );
    const ordinaryCurrentClips = trackClips.filter(
      (clip) => !compositeClipIds.has(clip.id),
    );
    const pinnedCompositeClips = plan.mainClips.filter((clip) =>
      compositeClipIds.has(clip.id) &&
      trackClips.some((currentClip) => currentClip.id === clip.id),
    );
    const mainClips = [...ordinaryCurrentClips, ...pinnedCompositeClips].sort(
      (left, right) =>
        left.start - right.start || left.id.localeCompare(right.id),
    );

    await Promise.all([
      this.mainRenderer.process(
        ctx,
        destination,
        mainClips,
        getInput,
        timeMapping,
        options,
      ),
      ...this.directRuntimes
        .filter((runtime) =>
          trackClips.some(
            (currentClip) => currentClip.id === runtime.getPlacementId(),
          ),
        )
        .map((runtime) =>
          runtime.process(ctx, destination, getInput, timeMapping, options),
        ),
    ]);
  }

  private ensurePlan(trackClips: TimelineClip[]): void {
    if (this.plan || !this.pendingSourceData) return;
    this.activeSourceData = this.pendingSourceData;
    this.plan = createCompositeAudioTrackPlan(
      this.trackId,
      this.activeSourceData,
    );
    this.directRuntimes = this.plan.directPlacements.map(
      (placement) =>
        new DirectCompositeAudioRuntime(placement, this.resetContextTime),
    );

    // Preserve ordinary fallback behavior if source data was captured before
    // this layer appeared and contains no clips for the track.
    if (
      this.plan.mainClips.length === 0 &&
      this.plan.directPlacements.length === 0 &&
      trackClips.length > 0
    ) {
      this.plan = { mainClips: trackClips, directPlacements: [] };
    }
  }

  private disposeDirectRuntimes(): void {
    for (const runtime of this.directRuntimes) runtime.dispose();
    this.directRuntimes = [];
  }
}
