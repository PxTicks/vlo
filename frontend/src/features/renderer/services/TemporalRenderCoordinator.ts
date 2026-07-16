import { getTicksPerFrame } from "../../../core/time/ticksPerFrame";
import { mediaSecondsToTickExact } from "../utils/mediaTime";
import type {
  FilterRenderContext,
  FilterRenderMode,
} from "../../transformations/catalogue/types";
import type { TemporalRenderingRequirements } from "../../transformations/catalogue/temporalRenderingRequirements";

export interface TemporalFramePlanRequest {
  readonly presentationTick: number;
  readonly fps: number;
  readonly mode: FilterRenderMode;
  readonly requirements: TemporalRenderingRequirements;
  readonly earliestTick?: number;
  readonly forceDiscontinuity?: boolean;
  /** Stable identity of enabled temporal transforms participating in the frame. */
  readonly topologyKey?: string;
}

export interface TemporalFramePlan {
  readonly warmup: readonly FilterRenderContext[];
  readonly target: FilterRenderContext;
  readonly isDiscontinuous: boolean;
}

/**
 * Derives an isolated temporal sequence for a conditional render branch, such
 * as an effect-masked filter. A branch becoming unavailable and later
 * renderable must not resume feedback retained from its previous activation.
 */
export class TemporalRenderBranch {
  private generation = 0;
  private lastBranchKey: string | null = null;

  reset(): void {
    this.lastBranchKey = null;
  }

  map(
    base: FilterRenderContext,
    branchKey: string,
  ): FilterRenderContext {
    const branchChanged = branchKey !== this.lastBranchKey;
    if (branchChanged) {
      this.generation += 1;
      this.lastBranchKey = branchKey;
    }

    return Object.freeze({
      ...base,
      // Global coordinator sequences occupy million-sized blocks; a branch
      // generation stays within its current block in any practical lifetime.
      sequenceId: base.sequenceId * 1_000_000 + this.generation,
      ...(branchChanged
        ? {
            continuity: "discontinuous" as const,
            deltaTimeTicks: null,
          }
        : {}),
    });
  }
}

/**
 * Host-owned sequence and bounded replay planner for temporal filters. It owns
 * no renderer state: callers execute every returned warm-up context through
 * their ordinary frame graph and submit it to a hidden render target.
 */
export class TemporalRenderCoordinator {
  private sequenceId = 0;
  private nextSampleId = 1;
  private lastTarget: FilterRenderContext | null = null;
  private lastTopologyKey: string | null = null;
  private invalidated = true;

  invalidate(): void {
    this.invalidated = true;
  }

  /**
   * Produce the pre-scheduler best-effort context used only while scrubbing.
   * It preserves the current sequence so retained filter state remains useful,
   * but leaves delta uncertified and invalidates the next exact plan.
   */
  createApproximatePreviewContext(
    presentationTick: number,
    fps: number,
  ): FilterRenderContext {
    const tick = Math.round(presentationTick);
    const target = this.createContext({
      sequenceId: this.lastTarget?.sequenceId ?? this.sequenceId,
      presentationTick: tick,
      mode: "preview",
      fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
      continuity: "sequential",
      deltaTimeTicks: null,
      isWarmup: false,
    });
    this.lastTarget = target;
    this.invalidated = true;
    return target;
  }

  plan(request: TemporalFramePlanRequest): TemporalFramePlan {
    const presentationTick = Math.round(request.presentationTick);
    const fps = Number.isFinite(request.fps) && request.fps > 0 ? request.fps : 0;
    const frameStep = fps > 0 ? getTicksPerFrame(fps) : 1;
    const previous = this.lastTarget;
    const topologyKey = request.topologyKey ?? "";
    const topologyChanged = topologyKey !== this.lastTopologyKey;
    const sameSample =
      !request.forceDiscontinuity &&
      !this.invalidated &&
      !topologyChanged &&
      previous !== null &&
      previous.mode === request.mode &&
      previous.presentationTimeTicks === presentationTick;

    if (sameSample) {
      const target = Object.freeze({
        ...previous,
        continuity: "repeat" as const,
        deltaTimeTicks: 0,
        isWarmup: false,
      });
      this.lastTarget = target;
      this.lastTopologyKey = topologyKey;
      return { warmup: [], target, isDiscontinuous: false };
    }

    const delta = previous
      ? presentationTick - previous.presentationTimeTicks
      : null;
    const declaredMaxStepTicks =
      request.requirements.maxStepSeconds === null
        ? null
        : Math.max(
            1,
            mediaSecondsToTickExact(request.requirements.maxStepSeconds),
          );
    const forwardCandidate =
      !request.forceDiscontinuity &&
      !this.invalidated &&
      !topologyChanged &&
      previous !== null &&
      previous.mode === request.mode &&
      delta !== null &&
      delta > 0;

    const bridgeSampleCount =
      forwardCandidate &&
      declaredMaxStepTicks !== null &&
      delta > declaredMaxStepTicks
        ? Math.ceil(delta / declaredMaxStepTicks) - 1
        : 0;
    const availableHistoryTicks = Math.min(
      mediaSecondsToTickExact(request.requirements.maxHistorySeconds),
      Math.max(
        0,
        presentationTick - Math.max(0, Math.round(request.earliestTick ?? 0)),
      ),
    );
    const replayStep = Math.max(
      1,
      Math.min(frameStep, declaredMaxStepTicks ?? frameStep),
    );
    const fullReplaySampleCount = Math.ceil(
      availableHistoryTicks / replayStep,
    );
    // A forward gap retains valid prior state. Bridge it while that is cheaper
    // than throwing the state away and replaying the bounded history window.
    // Backward/unknown jumps, topology changes, and very large forward seeks
    // still start a new sequence.
    const canBridgeForward =
      forwardCandidate &&
      (bridgeSampleCount === 0 ||
        (fullReplaySampleCount > 0 &&
          bridgeSampleCount <= fullReplaySampleCount));

    if (canBridgeForward) {
      const bridgeTicks: number[] = [];
      if (declaredMaxStepTicks !== null && delta > declaredMaxStepTicks) {
        for (
          let tick = previous.presentationTimeTicks + declaredMaxStepTicks;
          tick < presentationTick;
          tick += declaredMaxStepTicks
        ) {
          bridgeTicks.push(Math.round(tick));
        }
      }
      let previousTick = previous.presentationTimeTicks;
      const warmup = bridgeTicks.map((tick) => {
        const context = this.createContext({
          sequenceId: this.sequenceId,
          presentationTick: tick,
          mode: request.mode,
          fps,
          continuity: "sequential",
          deltaTimeTicks: tick - previousTick,
          isWarmup: true,
        });
        previousTick = tick;
        return context;
      });
      const target = this.createContext({
        sequenceId: this.sequenceId,
        presentationTick,
        mode: request.mode,
        fps,
        continuity: "sequential",
        deltaTimeTicks: presentationTick - previousTick,
        isWarmup: false,
      });
      this.lastTarget = target;
      this.lastTopologyKey = topologyKey;
      return { warmup, target, isDiscontinuous: false };
    }

    this.sequenceId += 1;
    this.invalidated = false;
    const earliestTick = Math.min(
      presentationTick,
      Math.max(0, Math.round(request.earliestTick ?? 0)),
    );
    const historyStart = Math.max(
      earliestTick,
      presentationTick -
        mediaSecondsToTickExact(request.requirements.maxHistorySeconds),
    );
    const warmupTicks: number[] = [];
    for (
      let tick = presentationTick - replayStep;
      tick >= historyStart;
      tick -= replayStep
    ) {
      warmupTicks.unshift(Math.round(tick));
    }
    if (
      request.requirements.maxHistorySeconds > 0 &&
      historyStart < presentationTick &&
      (warmupTicks.length === 0 || warmupTicks[0] !== historyStart)
    ) {
      warmupTicks.unshift(historyStart);
    }

    let previousTick: number | null = null;
    const warmup = warmupTicks.map((tick, index) => {
      const context = this.createContext({
        sequenceId: this.sequenceId,
        presentationTick: tick,
        mode: request.mode,
        fps,
        continuity: index === 0 ? "discontinuous" : "sequential",
        deltaTimeTicks: previousTick === null ? null : tick - previousTick,
        isWarmup: true,
      });
      previousTick = tick;
      return context;
    });
    const target = this.createContext({
      sequenceId: this.sequenceId,
      presentationTick,
      mode: request.mode,
      fps,
      continuity: warmup.length > 0 ? "sequential" : "discontinuous",
      deltaTimeTicks:
        previousTick === null ? null : presentationTick - previousTick,
      isWarmup: false,
    });
    this.lastTarget = target;
    this.lastTopologyKey = topologyKey;
    return { warmup, target, isDiscontinuous: true };
  }

  private createContext(input: {
    sequenceId: number;
    presentationTick: number;
    mode: FilterRenderMode;
    fps: number;
    continuity: FilterRenderContext["continuity"];
    deltaTimeTicks: number | null;
    isWarmup: boolean;
  }): FilterRenderContext {
    const tick = Math.round(input.presentationTick);
    return Object.freeze({
      sequenceId: input.sequenceId,
      sampleId: this.nextSampleId++,
      mode: input.mode,
      continuity: input.continuity,
      presentationTimeTicks: tick,
      visualTimeTicks: tick,
      sourceTimeTicks: tick,
      deltaTimeTicks: input.deltaTimeTicks,
      fps: input.fps,
      isWarmup: input.isWarmup,
    });
  }
}
