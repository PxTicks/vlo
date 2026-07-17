import { Input, AudioBufferSink } from "mediabunny";
import type { WrappedAudioBuffer } from "mediabunny";
import { ticksPerFrame } from "../../../core/time/frameGrid";
import { resolveScalar } from "../../transformations/utils/resolveScalar";
import {
  tickToMediaSeconds,
  mediaSecondsToTickExact,
} from "../utils/mediaTime";
import {
  resolveClipRenderTime,
} from "../utils/clipRenderTime";
import { resolveLiveActiveClip } from "../utils/clipLookup";
import type { AudioEffectTransform, ScalarParameter } from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import {
  buildAudioEffectChain,
  computeAudioEffectSignature,
  estimateAudioEffectTailSeconds,
  getAudioEffectTransforms,
  type AudioEffectChain,
} from "./audioEffectChain";

const REALTIME_CURVE_SAMPLE_COUNT = 64;
const OFFLINE_CURVE_SAMPLE_COUNT = 256;
const MIN_SCHEDULE_STEP_SECONDS = 0.01;
const REALTIME_STAGING_TARGET_SECONDS = 0.5;
const OFFLINE_STAGING_TARGET_SECONDS = 2.0;
const URGENT_SCHEDULE_WINDOW_SECONDS = 0.2;
const MIN_STAGING_DURATION_SECONDS = 0.1;
const MAX_REALTIME_SCHEDULE_LAG_SECONDS = 0.25;

function isRealtimeAudioContext(ctx: BaseAudioContext): boolean {
  return (
    typeof OfflineAudioContext === "undefined" ||
    !(ctx instanceof OfflineAudioContext)
  );
}

export function getConstantVolumeGain(clip: TimelineClip): number | null {
  const volumeTransform = (clip.transformations || []).find(
    (t) => t.isEnabled && t.type === "volume",
  );

  if (!volumeTransform) return 1;

  const gain = (volumeTransform.parameters as { gain?: unknown }).gain;
  return typeof gain === "number" ? gain : null;
}

interface ClipCurveEvaluators {
  constantVolumeGain: number | null;
  evaluateVolume: (sourceTimeTicks: number) => number;
}

export function createClipCurveEvaluators(
  clip: TimelineClip,
): ClipCurveEvaluators {
  const transforms = clip.transformations || [];
  const constantVolumeGain = getConstantVolumeGain(clip);
  const volumeTransform = transforms.find(
    (t) => t.isEnabled && t.type === "volume",
  );
  const volumeParam = (
    volumeTransform?.parameters as { gain?: ScalarParameter } | undefined
  )?.gain;

  return {
    constantVolumeGain,
    evaluateVolume: (sourceTimeTicks: number) => {
      if (constantVolumeGain !== null) return Math.max(0, constantVolumeGain);
      return Math.max(0, resolveScalar(volumeParam, sourceTimeTicks, 1.0));
    },
  };
}

export interface TrackAudioRendererState {
  input: Input | null;
  sink: AudioBufferSink | null;
  iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null;
  currentClipId: string | null;
  lastAudioEndTimestamp: number | null;
  hasAudio: boolean;
  staging: {
    buffers: WrappedAudioBuffer[];
    totalLength: number;
    totalSourceDuration: number;
    startTargetTicks: number;
    startContextTime: number;
    activeClip: TimelineClip | null;
  };
}

interface ManagedAudioEffectChain {
  clipId: string;
  signature: string;
  ctx: BaseAudioContext;
  destination: AudioNode;
  chain: AudioEffectChain;
  tailSeconds: number;
  activeSources: number;
  lastScheduledEndTime: number;
}

interface ScheduledAudioEffectChain {
  managed: ManagedAudioEffectChain;
  transforms: AudioEffectTransform[];
}

export interface TrackAudioActiveClipResolution {
  clip: TimelineClip;
  effectiveTick: number;
}

/**
 * Optional timing seam for sources whose presentation clock is owned by a
 * parent clip. Composite audio uses it to map parent presentation time into a
 * child timeline without cloning timing transforms onto child clips.
 */
export interface TrackAudioTimingResolver {
  findActiveClipAtPresentation(
    trackClips: readonly TimelineClip[],
    presentationTick: number,
  ): TrackAudioActiveClipResolution | null;
  getSourceTicksAtPresentationTick(
    clip: TimelineClip,
    presentationTick: number,
  ): number;
}

export class TrackAudioRenderer {
  private state: TrackAudioRendererState = {
    input: null,
    sink: null,
    iterator: null,
    currentClipId: null,
    lastAudioEndTimestamp: null,
    hasAudio: false,
    staging: {
      buffers: [],
      totalLength: 0,
      totalSourceDuration: 0,
      startTargetTicks: 0,
      startContextTime: 0,
      activeClip: null,
    },
  };

  private scheduledNodes: AudioBufferSourceNode[] = [];
  private nextScheduleTime: number = 0; // Context Time

  // Persistent audio effect chains (pan/EQ/compressor/reverb/delay), retained
  // per clip occurrence until scheduled source audio and estimated tails finish.
  // This prevents scheduling clip B from disconnecting already-scheduled clip A
  // audio, while still letting topology edits create a fresh chain for future
  // chunks without cutting old chunks.
  private effectChains: ManagedAudioEffectChain[] = [];

  // Cache for asset inputs to avoid recreating them constantly if passed externally
  // But typically the caller (hook) manages the asset store interaction.
  // We will accept a `getInput` function.

  public readonly trackId: string;
  private readonly adjustmentEffectResolver: AdjustmentEffectResolver | null;
  private readonly timingResolver: TrackAudioTimingResolver | null;

  constructor(
    trackId: string,
    adjustmentEffectResolver?: AdjustmentEffectResolver | null,
    timingResolver?: TrackAudioTimingResolver | null,
  ) {
    this.trackId = trackId;
    this.adjustmentEffectResolver = adjustmentEffectResolver ?? null;
    this.timingResolver = timingResolver ?? null;
  }

  public getNextScheduleTime() {
    return this.nextScheduleTime;
  }

  /**
   * Per-clip presentation rebase for an arbitrary presentation tick: we
   * resolve it against the clip's own footprint via the lookup, falling
   * back to identity when no resolver is wired (tests / simple cases).
   */
  private resolveEffectiveTrackTickForClip(
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

  private findActiveClipAtPresentation(
    trackClips: TimelineClip[],
    presentationTick: number,
  ): { clip: TimelineClip; effectiveTick: number } | null {
    if (this.timingResolver) {
      return this.timingResolver.findActiveClipAtPresentation(
        trackClips,
        presentationTick,
      );
    }

    if (this.adjustmentEffectResolver && this.trackId) {
      // Lookup owns identity + timing; re-bind to the live clip by id so volume
      // /timing edits aren't served from the stale cache. See clipLookup.
      const resolved = resolveLiveActiveClip(
        this.adjustmentEffectResolver,
        this.trackId,
        trackClips,
        presentationTick,
      );
      if (resolved) {
        return { clip: resolved.clip, effectiveTick: resolved.effectiveTick };
      }
    }

    // No resolver, or an audio-only composite that expanded into synthetic lane
    // clips not present in the adjustment lookup. They already carry parent
    // timing, so scan the supplied lane directly as a fallback.
    for (const candidate of trackClips) {
      const clipEnd = candidate.start + candidate.timelineDuration;
      if (candidate.start <= presentationTick && presentationTick < clipEnd) {
        return { clip: candidate, effectiveTick: presentationTick };
      }
    }
    return null;
  }

  private getSourceTicksAtPresentationTick(
    clip: TimelineClip,
    presentationTick: number,
  ): number {
    if (this.timingResolver) {
      return this.timingResolver.getSourceTicksAtPresentationTick(
        clip,
        presentationTick,
      );
    }

    return resolveClipRenderTime({
      clip,
      presentationTick,
      resolveEffectiveTrackTick: (targetClip, tick) =>
        this.resolveEffectiveTrackTickForClip(targetClip, tick),
    }).sourceTimeTicks;
  }

  private evaluateCompositePlaybackRate(
    clip: TimelineClip,
    presentationTick: number,
  ): number {
    const sampleDeltaTicks = 100;
    const t0 = Math.max(0, presentationTick - sampleDeltaTicks);
    const t1 = presentationTick + sampleDeltaTicks;
    const s0 = this.getSourceTicksAtPresentationTick(clip, t0);
    const s1 = this.getSourceTicksAtPresentationTick(clip, t1);
    const deltaTicks = t1 - t0;

    if (Math.abs(deltaTicks) <= 1e-9) {
      return 1.0;
    }

    const rate = (s1 - s0) / deltaTicks;
    return Number.isFinite(rate) && rate > 0 ? rate : 1.0;
  }

  private solvePresentationDurationTicks(
    clip: TimelineClip,
    startPresentationTick: number,
    sourceDurationTicks: number,
  ): number {
    if (!Number.isFinite(sourceDurationTicks) || sourceDurationTicks <= 0) {
      return 0;
    }

    const startSourceTicks = this.getSourceTicksAtPresentationTick(
      clip,
      startPresentationTick,
    );
    const targetSourceTicks = startSourceTicks + sourceDurationTicks;

    let low = 0;
    let high = Math.max(sourceDurationTicks, ticksPerFrame(60));

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const sourceAtHigh = this.getSourceTicksAtPresentationTick(
        clip,
        startPresentationTick + high,
      );
      if (sourceAtHigh >= targetSourceTicks) {
        break;
      }
      high *= 2;
    }

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const mid = (low + high) / 2;
      const sourceAtMid = this.getSourceTicksAtPresentationTick(
        clip,
        startPresentationTick + mid,
      );
      if (sourceAtMid >= targetSourceTicks) {
        high = mid;
      } else {
        low = mid;
      }
    }

    return high;
  }

  public reset(contextTime: number) {
    this.cleanupNodes();
    this.nextScheduleTime = contextTime + 0.15; // Pre-buffer

    // Reset Iterator state
    this.closeIteratorInBackground(this.state.iterator);

    this.state = {
      input: null,
      sink: null,
      iterator: null,
      currentClipId: null,
      lastAudioEndTimestamp: null,
      hasAudio: false,
      staging: {
        buffers: [],
        totalLength: 0,
        totalSourceDuration: 0,
        startTargetTicks: 0,
        startContextTime: 0,
        activeClip: null,
      },
    };
  }

  public stop() {
    this.cleanupNodes();
  }

  public dispose() {
    this.cleanupNodes();
    this.closeIteratorInBackground(this.state.iterator);
    // input is managed externally usually? No, useAudioTrack cached input in store but sink here.
    this.state.input = null;
    this.state.sink = null;
    this.state.iterator = null;
  }

  /**
   * Ensure the persistent effect chain matches the clip's current effect
   * topology and the active context. Returns the chain to route into, or null
   * when the clip has no audio effects (caller routes straight to destination).
   */
  private ensureEffectChain(
    ctx: BaseAudioContext,
    clip: TimelineClip,
    destination: AudioNode,
  ): ScheduledAudioEffectChain | null {
    const transforms = getAudioEffectTransforms(clip);
    const signature = computeAudioEffectSignature(transforms);

    if (transforms.length === 0) return null;

    this.cleanupInactiveEffectChains(ctx.currentTime);

    const existing = this.effectChains.find(
      (entry) =>
        entry.clipId === clip.id &&
        entry.signature === signature &&
        entry.ctx === ctx &&
        entry.destination === destination,
    );
    if (existing) {
      existing.tailSeconds = Math.max(
        existing.tailSeconds,
        estimateAudioEffectTailSeconds(transforms),
      );
      return { managed: existing, transforms };
    }

    const chain = buildAudioEffectChain(ctx, transforms);
    if (!chain) return null;
    chain.outputNode.connect(destination);
    const managed: ManagedAudioEffectChain = {
      clipId: clip.id,
      signature,
      ctx,
      destination,
      chain,
      tailSeconds: estimateAudioEffectTailSeconds(transforms),
      activeSources: 0,
      lastScheduledEndTime: 0,
    };
    this.effectChains.push(managed);
    return { managed, transforms };
  }

  private disposeEffectChains() {
    for (const entry of this.effectChains) {
      entry.chain.dispose();
    }
    this.effectChains = [];
  }

  private cleanupInactiveEffectChains(currentTime: number) {
    const retained: ManagedAudioEffectChain[] = [];
    for (const entry of this.effectChains) {
      const tailEndTime = entry.lastScheduledEndTime + entry.tailSeconds;
      if (entry.activeSources === 0 && currentTime >= tailEndTime) {
        entry.chain.dispose();
      } else {
        retained.push(entry);
      }
    }
    this.effectChains = retained;
  }

  private markEffectChainScheduled(
    entry: ManagedAudioEffectChain,
    startContextTime: number,
    wallDuration: number,
  ) {
    entry.activeSources += 1;
    entry.lastScheduledEndTime = Math.max(
      entry.lastScheduledEndTime,
      startContextTime + wallDuration,
    );
  }

  private releaseEffectChainSource(entry: ManagedAudioEffectChain) {
    entry.activeSources = Math.max(0, entry.activeSources - 1);
  }

  private cleanupNodes() {
    this.disposeEffectChains();
    this.scheduledNodes.forEach((node) => {
      try {
        node.stop();
        node.disconnect();
      } catch {
        /* ignore */
      }
    });
    this.scheduledNodes = [];
  }

  private async closeIterator(
    iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null,
  ) {
    if (!iterator || typeof iterator.return !== "function") return;
    try {
      await iterator.return();
    } catch {
      /* ignore */
    }
  }

  private closeIteratorInBackground(
    iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null,
  ) {
    void this.closeIterator(iterator);
  }

  /**
   * Main processing loop. Can be called repeatedly.
   *
   * @param ctx The AudioContext (Realtime or Offline)
   * @param destination The destination node (e.g. Master Gain)
   * @param trackClips Clips on this track
   * @param getInput Async function to get Input for an asset ID
   * @param timeState Defines the synchronization between Context Time and Timeline Duration
   *                  For Playback: { nowTicks: number, contextTime: number } (Start of playback)
   *                  actually update logic uses `getCurrentPlaybackTicks` which changes.
   *
   *                  We need: "Map ContextTime to Ticks".
   *                  ticks = baseTicks + (contextTime - baseContextTime) * TICKS_PER_SECOND
   */
  public async process(
    ctx: BaseAudioContext,
    destination: AudioNode,
    trackClips: TimelineClip[],
    getInput: (assetId: string) => Promise<Input | null>,
    timeMapping: {
      baseTicks: number; // Ticks at baseContextTime
      baseContextTime: number; // Context time reference
    },
    options: {
      lookahead: number;
      forceFlush?: boolean;
    },
  ) {
    // We assume the caller handles the loop/interval.
    // We execute ONE pass of filling the buffer up to lookahead.

    // Determine target ticks mapping
    const getTargetTicks = (ctxTime: number) => {
      const deltaSeconds = ctxTime - timeMapping.baseContextTime;
      return timeMapping.baseTicks + mediaSecondsToTickExact(deltaSeconds);
    };

    // If renderer work starves long enough for the schedule cursor to fall
    // well behind the hardware audio clock, decoding the expired backlog only
    // prolongs the dropout. Rebase live playback onto a fresh pre-buffered
    // cursor; offline rendering has no advancing deadline and must stay exact.
    const recoverExpiredRealtimeSchedule = (): boolean => {
      if (
        !isRealtimeAudioContext(ctx) ||
        this.nextScheduleTime >=
          ctx.currentTime - MAX_REALTIME_SCHEDULE_LAG_SECONDS
      ) {
        return false;
      }
      this.reset(ctx.currentTime);
      return true;
    };
    recoverExpiredRealtimeSchedule();

    const clipCurveCache = new Map<string, ClipCurveEvaluators>();
    const getClipCurveEvaluators = (
      clip: TimelineClip,
    ): ClipCurveEvaluators => {
      const cached = clipCurveCache.get(clip.id);
      if (cached) return cached;
      const created = createClipCurveEvaluators(clip);
      clipCurveCache.set(clip.id, created);
      return created;
    };

    const resetStagingState = () => {
      this.state.staging = {
        buffers: [],
        totalLength: 0,
        totalSourceDuration: 0,
        startTargetTicks: 0,
        startContextTime: 0,
        activeClip: null,
      };
    };

    const flushStagingBuffer = async () => {
      const {
        buffers,
        totalLength,
        totalSourceDuration,
        startTargetTicks,
        startContextTime,
        activeClip,
      } = this.state.staging;

      if (buffers.length === 0) return;
      if (!activeClip) {
        resetStagingState();
        return;
      }

      // 1. Merge buffers (or skip merge for single-buffer staging)
      const finalBuffer =
        buffers.length === 1
          ? buffers[0].buffer
          : (() => {
              const bufRate = buffers[0].buffer.sampleRate;
              const merged = ctx.createBuffer(
                buffers[0].buffer.numberOfChannels,
                totalLength,
                bufRate,
              );
              let offset = 0;
              for (const wrappedBuffer of buffers) {
                for (
                  let ch = 0;
                  ch < wrappedBuffer.buffer.numberOfChannels;
                  ch++
                ) {
                  merged.copyToChannel(
                    wrappedBuffer.buffer.getChannelData(ch),
                    ch,
                    offset,
                  );
                }
                offset += wrappedBuffer.buffer.length;
              }
              return merged;
            })();

      // 2. Schedule
      const source = ctx.createBufferSource();
      source.buffer = finalBuffer;

      // Gain mechanism
      const gainNode = ctx.createGain();
      source.connect(gainNode);

      // Route the per-chunk gain node into the clip's persistent audio effect
      // chain when present; otherwise straight to the destination (volume-only
      // clips are unchanged).
      const effectChain = this.ensureEffectChain(ctx, activeClip, destination);
      gainNode.connect(
        effectChain ? effectChain.managed.chain.inputNode : destination,
      );

      const clipCurves = getClipCurveEvaluators(activeClip);
      const contentTicks = mediaSecondsToTickExact(totalSourceDuration);
      const wallDurationTicks = this.solvePresentationDurationTicks(
        activeClip,
        startTargetTicks,
        contentTicks,
      );
      const wallDuration = tickToMediaSeconds(wallDurationTicks);

      if (!Number.isFinite(wallDuration) || wallDuration <= 0) {
        resetStagingState();
        return;
      }

      const sampleCount = Math.max(
        2,
        isRealtimeAudioContext(ctx)
          ? REALTIME_CURVE_SAMPLE_COUNT
          : OFFLINE_CURVE_SAMPLE_COUNT,
      );

      const speedCurve = new Float32Array(sampleCount);
      const timeStep =
        mediaSecondsToTickExact(wallDuration) / (sampleCount - 1);

      for (let i = 0; i < sampleCount; i++) {
        const t = startTargetTicks + i * timeStep;
        speedCurve[i] = this.evaluateCompositePlaybackRate(activeClip, t);
      }

      try {
        source.playbackRate.setValueCurveAtTime(
          speedCurve,
          startContextTime,
          wallDuration,
        );
      } catch {
        source.playbackRate.value = speedCurve[0];
      }

      // De-clicking parameters
      const FADE_DURATION = 0.003;
      const actualFade = Math.min(FADE_DURATION, wallDuration / 2);

      if (clipCurves.constantVolumeGain !== null) {
        const gain = Math.max(0, clipCurves.constantVolumeGain);
        gainNode.gain.cancelScheduledValues(startContextTime);
        gainNode.gain.setValueAtTime(0, startContextTime);

        if (actualFade > 0) {
          gainNode.gain.linearRampToValueAtTime(
            gain,
            startContextTime + actualFade,
          );
          gainNode.gain.setValueAtTime(
            gain,
            Math.max(
              startContextTime + actualFade,
              startContextTime + wallDuration - actualFade,
            ),
          );
          gainNode.gain.linearRampToValueAtTime(
            0,
            startContextTime + wallDuration,
          );
        } else {
          gainNode.gain.setValueAtTime(gain, startContextTime);
        }
      } else {
        // Generate Volume Curve (combined with de-clicking envelope)
        const volumeCurve = new Float32Array(sampleCount);
        const volumeTimeStep =
          mediaSecondsToTickExact(wallDuration) / (sampleCount - 1);
        const fadeInSamples = Math.max(
          1,
          Math.floor((actualFade / wallDuration) * sampleCount),
        );
        const fadeOutSamples = fadeInSamples;

        for (let i = 0; i < sampleCount; i++) {
          const t = startTargetTicks + i * volumeTimeStep;
          const volumeGain = clipCurves.evaluateVolume(
            this.getSourceTicksAtPresentationTick(activeClip, t),
          );

          // Apply de-clicking envelope
          let deClickMultiplier = 1.0;
          if (i < fadeInSamples) {
            deClickMultiplier = i / fadeInSamples; // Linear fade in
          } else if (i >= sampleCount - fadeOutSamples) {
            const fadeOutProgress = (sampleCount - 1 - i) / fadeOutSamples;
            deClickMultiplier = fadeOutProgress; // Linear fade out
          }

          volumeCurve[i] = volumeGain * deClickMultiplier;
        }

        // Apply combined volume curve
        try {
          gainNode.gain.setValueCurveAtTime(
            volumeCurve,
            startContextTime,
            wallDuration,
          );
        } catch {
          gainNode.gain.value = volumeCurve[0];
        }
      }

      // Schedule audio effect parameter automation for this chunk window.
      // Splined effect params evaluate exactly like volume (same tick mapping).
      if (effectChain) {
        effectChain.managed.chain.scheduleAutomation(
          {
            startContextTime,
            wallDurationSeconds: wallDuration,
            startTargetTicks,
            windowTicks: mediaSecondsToTickExact(wallDuration),
            sampleCount,
            sourceTimeTicksAt: (t) =>
              this.getSourceTicksAtPresentationTick(activeClip, t),
          },
          effectChain.transforms,
        );
        this.markEffectChainScheduled(
          effectChain.managed,
          startContextTime,
          wallDuration,
        );
      }

      // Scheduling
      // Note: In OfflineContext, context.currentTime is always 0 (or start).
      // But for Playback it moves.
      if (startContextTime < ctx.currentTime) {
        // Late schedule
        const offset = ctx.currentTime - startContextTime;
        if (offset < wallDuration) {
          // AudioBufferSourceNode offsets are expressed in source-media time,
          // so a wall-clock offset multiplied by only the ramp's initial rate
          // drifts whenever playback speed changes within the late window.
          const latePresentationTick =
            startTargetTicks + mediaSecondsToTickExact(offset);
          const sourceOffsetTicks =
            this.getSourceTicksAtPresentationTick(
              activeClip,
              latePresentationTick,
            ) -
            this.getSourceTicksAtPresentationTick(
              activeClip,
              startTargetTicks,
            );
          const sourceOffsetSeconds = Math.max(
            0,
            tickToMediaSeconds(sourceOffsetTicks),
          );
          source.start(ctx.currentTime, sourceOffsetSeconds);
          this.scheduledNodes.push(source);
          source.onended = () => {
            if (effectChain) {
              this.releaseEffectChainSource(effectChain.managed);
            }
            const idx = this.scheduledNodes.indexOf(source);
            if (idx > -1) this.scheduledNodes.splice(idx, 1);
            this.cleanupInactiveEffectChains(ctx.currentTime);
          };
        } else if (effectChain) {
          this.releaseEffectChainSource(effectChain.managed);
          this.cleanupInactiveEffectChains(ctx.currentTime);
        }
      } else {
        source.start(startContextTime);
        this.scheduledNodes.push(source);
        source.onended = () => {
          if (effectChain) {
            this.releaseEffectChainSource(effectChain.managed);
          }
          const idx = this.scheduledNodes.indexOf(source);
          if (idx > -1) this.scheduledNodes.splice(idx, 1);
          this.cleanupInactiveEffectChains(ctx.currentTime);
        };
      }

      resetStagingState();
    };

    // --- LOOP ---
    // In export mode, lookahead can be large (duration of clip).
    // In live mode, it is small.

    // We only loop if we need to fill time.

    while (this.nextScheduleTime < ctx.currentTime + options.lookahead) {
      // currentTime can advance substantially while a decode is awaited, so
      // repeat the lag check inside the fill loop as well as at entry.
      if (recoverExpiredRealtimeSchedule()) {
        continue;
      }
      const targetTicks = getTargetTicks(this.nextScheduleTime);
      // Active clip lookup by *presentation* tick. The returned
      // `effectiveTick` has already applied the clip's static/ripple
      // placement model and feeds the shared clip render-time resolver below.
      const resolved = this.findActiveClipAtPresentation(
        trackClips,
        targetTicks,
      );
      const activeClip = resolved?.clip;

      if (
        !activeClip ||
        (activeClip.type !== "video" && activeClip.type !== "audio") ||
        activeClip.isMuted
      ) {
        await flushStagingBuffer();
        this.nextScheduleTime += 0.1;
        continue;
      }

      // Init Controller
      const c = this.state;
      if (c.currentClipId !== activeClip.id) {
        await flushStagingBuffer();

        // Cleanup old iterator
        await this.closeIterator(c.iterator);
        c.iterator = null;

        // Reset State
        c.staging = {
          buffers: [],
          totalLength: 0,
          totalSourceDuration: 0,
          startTargetTicks: 0,
          startContextTime: 0,
          activeClip: null,
        };

        if (!activeClip.assetId) {
          this.nextScheduleTime += 0.1;
          continue;
        }

        const input = await getInput(activeClip.assetId);
        if (!input) {
          this.nextScheduleTime += 0.1;
          continue;
        }

        try {
          const track = await input.getPrimaryAudioTrack();
          if (!track) {
            c.currentClipId = activeClip.id;
            c.hasAudio = false;
            this.nextScheduleTime += 0.1;
            continue;
          }
          const sink = new AudioBufferSink(track);
          c.input = input;
          c.sink = sink;
          c.currentClipId = activeClip.id;
          c.lastAudioEndTimestamp = null;
          c.hasAudio = true;
          // Iterator created on demand
          c.iterator = null;
        } catch (e) {
          console.warn("Audio Init Failed", e);
          c.currentClipId = activeClip.id;
          c.hasAudio = false;
          this.nextScheduleTime += 0.1;
          continue;
        }
      }

      if (!c.hasAudio) {
        this.nextScheduleTime += 0.1;
        continue;
      }

      // Get/Create Iterator
      const localTimeSeconds = tickToMediaSeconds(
        this.getSourceTicksAtPresentationTick(activeClip, targetTicks),
      );
      const epsilon = 0.1;
      const isSequential =
        c.lastAudioEndTimestamp !== null &&
        Math.abs(localTimeSeconds - c.lastAudioEndTimestamp) < epsilon;

      if (!c.iterator || !isSequential) {
        await flushStagingBuffer();
        await this.closeIterator(c.iterator);
        c.iterator = null;
        if (c.sink) {
          c.iterator = c.sink.buffers(localTimeSeconds);
        }
      }

      // Pull
      if (!c.iterator) {
        // Should not happen
        this.nextScheduleTime += 0.1;
        continue;
      }

      const result = await c.iterator.next();
      if (result.done) {
        await flushStagingBuffer();
        await this.closeIterator(c.iterator);
        c.iterator = null;
        c.lastAudioEndTimestamp = null;
        this.nextScheduleTime += 0.1;
        continue;
      }

      const { buffer, timestamp } = result.value;
      c.lastAudioEndTimestamp = timestamp + buffer.duration;

      // Accumulate
      if (c.staging.buffers.length === 0) {
        c.staging.startTargetTicks = targetTicks;
        c.staging.startContextTime = this.nextScheduleTime;
        c.staging.activeClip = activeClip;
      }

      c.staging.buffers.push(result.value);
      c.staging.totalLength += buffer.length;
      c.staging.totalSourceDuration += buffer.duration;

      const chunkContentTicks = mediaSecondsToTickExact(buffer.duration);
      const chunkWallDurationTicks = this.solvePresentationDurationTicks(
        activeClip,
        targetTicks,
        chunkContentTicks,
      );
      const chunkWallDuration = tickToMediaSeconds(chunkWallDurationTicks);

      if (!Number.isFinite(chunkWallDuration) || chunkWallDuration <= 0) {
        await flushStagingBuffer();
        await this.closeIterator(c.iterator);
        c.iterator = null;
        c.lastAudioEndTimestamp = null;
        this.nextScheduleTime += MIN_SCHEDULE_STEP_SECONDS;
        continue;
      }

      this.nextScheduleTime += chunkWallDuration;

      // Flush Condition
      // For Export: We want largest possible stable chunks?
      // For Live: We want responsiveness.
      const timeUntilDeadline = c.staging.startContextTime - ctx.currentTime;
      const isUrgent =
        timeUntilDeadline < URGENT_SCHEDULE_WINDOW_SECONDS;
      const bufferedDuration =
        this.nextScheduleTime - c.staging.startContextTime;

      // Commit live chunks incrementally. Keeping two seconds in staging made
      // all of that decoded audio vulnerable to a later main-thread stall;
      // smaller scheduled nodes continue playing on the audio thread while
      // the renderer catches up. Offline export retains the larger batches.
      const stagingTarget = isUrgent
        ? MIN_STAGING_DURATION_SECONDS
        : isRealtimeAudioContext(ctx)
          ? REALTIME_STAGING_TARGET_SECONDS
          : OFFLINE_STAGING_TARGET_SECONDS;
      if (bufferedDuration >= stagingTarget) {
        await flushStagingBuffer();
      }
    } // End While

    // If loop finished but something is staged, we keep it for next call?
    // In Live mode: Yes.
    // In Export mode: We probably call this until nextScheduleTime >= duration, then we should flush last bit.
    // But flush happens in loop on urgency or threshold.
    if (options.forceFlush) {
      await flushStagingBuffer();
    }
  }
}
