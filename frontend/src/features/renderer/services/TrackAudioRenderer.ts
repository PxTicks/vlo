import { Input, AudioBufferSink } from "mediabunny";
import type { WrappedAudioBuffer } from "mediabunny";
import { TICKS_PER_SECOND } from "../../timeline";
import { resolveScalar } from "../../transformations";
import { calculatePlayerFrameTime } from "../utils/renderTime";
import type { ScalarParameter } from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";

const REALTIME_CURVE_SAMPLE_COUNT = 64;
const OFFLINE_CURVE_SAMPLE_COUNT = 256;
const MIN_SCHEDULE_STEP_SECONDS = 0.01;

function isRealtimeAudioContext(ctx: BaseAudioContext): boolean {
  return (
    typeof OfflineAudioContext === "undefined" ||
    !(ctx instanceof OfflineAudioContext)
  );
}

function getConstantVolumeGain(clip: TimelineClip): number | null {
  const volumeTransform = (clip.transformations || []).find(
    (t) => t.isEnabled && t.type === "volume",
  );

  if (!volumeTransform) return 1;

  const gain = (volumeTransform.parameters as { gain?: unknown }).gain;
  return typeof gain === "number" ? gain : null;
}

interface ClipCurveEvaluators {
  constantVolumeGain: number | null;
  evaluateVolume: (localTimeTicks: number) => number;
}

function createClipCurveEvaluators(clip: TimelineClip): ClipCurveEvaluators {
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
    evaluateVolume: (localTimeTicks: number) => {
      if (constantVolumeGain !== null) return Math.max(0, constantVolumeGain);
      return Math.max(0, resolveScalar(volumeParam, localTimeTicks, 1.0));
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

  // Cache for asset inputs to avoid recreating them constantly if passed externally
  // But typically the caller (hook) manages the asset store interaction.
  // We will accept a `getInput` function.

  public readonly trackId: string;
  private readonly adjustmentEffectResolver: AdjustmentEffectResolver | null;

  constructor(
    trackId: string,
    adjustmentEffectResolver?: AdjustmentEffectResolver | null,
  ) {
    this.trackId = trackId;
    this.adjustmentEffectResolver = adjustmentEffectResolver ?? null;
  }

  public getNextScheduleTime() {
    return this.nextScheduleTime;
  }

  private resolveEffectiveTrackTick(presentationTick: number): number {
    if (!this.adjustmentEffectResolver) {
      return presentationTick;
    }

    return this.adjustmentEffectResolver
      .getTimeResolver()
      .resolveEffectiveTrackTick(this.trackId, presentationTick);
  }

  private getSourceTicksAtPresentationTick(
    clip: TimelineClip,
    presentationTick: number,
  ): number {
    const effectiveTick = this.resolveEffectiveTrackTick(presentationTick);
    return calculatePlayerFrameTime(clip, effectiveTick) * TICKS_PER_SECOND;
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
    let high = Math.max(sourceDurationTicks, TICKS_PER_SECOND / 60);

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

  /**
   * Resets the internal scheduling timer without clearing the decoding state.
   * Useful for chunked offline rendering where we create new AudioContexts.
   */
  public prepareForChunk(startTime: number) {
    this.nextScheduleTime = startTime;
    this.cleanupNodes();
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

  private cleanupNodes() {
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
      return timeMapping.baseTicks + deltaSeconds * TICKS_PER_SECOND;
    };

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

    let clipCursor = 0;
    const getActiveClipAtTicks = (
      targetTicks: number,
    ): TimelineClip | undefined => {
      if (trackClips.length === 0) return undefined;

      if (clipCursor < 0) clipCursor = 0;
      if (clipCursor >= trackClips.length) clipCursor = trackClips.length - 1;

      while (clipCursor < trackClips.length) {
        const clip = trackClips[clipCursor];
        const clipEnd = clip.start + clip.timelineDuration;
        if (targetTicks < clip.start) break;
        if (targetTicks >= clipEnd) {
          clipCursor += 1;
          continue;
        }
        return clip;
      }

      while (clipCursor > 0) {
        const candidate = trackClips[clipCursor - 1];
        if (targetTicks < candidate.start) {
          clipCursor -= 1;
          continue;
        }
        if (targetTicks < candidate.start + candidate.timelineDuration) {
          clipCursor -= 1;
          return trackClips[clipCursor];
        }
        break;
      }

      const candidate = trackClips[clipCursor];
      if (
        candidate &&
        targetTicks >= candidate.start &&
        targetTicks < candidate.start + candidate.timelineDuration
      ) {
        return candidate;
      }

      return undefined;
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
      gainNode.connect(destination);

      const clipCurves = getClipCurveEvaluators(activeClip);
      const contentTicks = totalSourceDuration * TICKS_PER_SECOND;
      const wallDurationTicks = this.solvePresentationDurationTicks(
        activeClip,
        startTargetTicks,
        contentTicks,
      );
      const wallDuration = wallDurationTicks / TICKS_PER_SECOND;

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
      const timeStep = (wallDuration * TICKS_PER_SECOND) / (sampleCount - 1);

      for (let i = 0; i < sampleCount; i++) {
        const t = startTargetTicks + i * timeStep;
        speedCurve[i] = this.evaluateCompositePlaybackRate(activeClip, t);
      }

      const startPlaybackRate = speedCurve[0];

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
          (wallDuration * TICKS_PER_SECOND) / (sampleCount - 1);
        const fadeInSamples = Math.max(
          1,
          Math.floor((actualFade / wallDuration) * sampleCount),
        );
        const fadeOutSamples = fadeInSamples;

        for (let i = 0; i < sampleCount; i++) {
          const t = startTargetTicks + i * volumeTimeStep;
          const effectiveTick = this.resolveEffectiveTrackTick(t);
          const volumeGain = clipCurves.evaluateVolume(
            effectiveTick - activeClip.start,
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

      // Scheduling
      // Note: In OfflineContext, context.currentTime is always 0 (or start).
      // But for Playback it moves.
      if (startContextTime < ctx.currentTime) {
        // Late schedule
        const offset = ctx.currentTime - startContextTime;
        if (offset < wallDuration) {
          source.start(ctx.currentTime, offset * startPlaybackRate);
          this.scheduledNodes.push(source);
          source.onended = () => {
            const idx = this.scheduledNodes.indexOf(source);
            if (idx > -1) this.scheduledNodes.splice(idx, 1);
          };
        }
      } else {
        source.start(startContextTime);
        this.scheduledNodes.push(source);
        source.onended = () => {
          const idx = this.scheduledNodes.indexOf(source);
          if (idx > -1) this.scheduledNodes.splice(idx, 1);
        };
      }

      resetStagingState();
    };

    // --- LOOP ---
    // In export mode, lookahead can be large (duration of clip).
    // In live mode, it is small.

    // We only loop if we need to fill time.

    while (this.nextScheduleTime < ctx.currentTime + options.lookahead) {
      const targetTicks = getTargetTicks(this.nextScheduleTime);
      const effectiveTrackTick = this.resolveEffectiveTrackTick(targetTicks);

      const activeClip = getActiveClipAtTicks(effectiveTrackTick);

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
      const localTimeSeconds = calculatePlayerFrameTime(
        activeClip,
        effectiveTrackTick,
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

      const chunkContentTicks = buffer.duration * TICKS_PER_SECOND;
      const chunkWallDurationTicks = this.solvePresentationDurationTicks(
        activeClip,
        targetTicks,
        chunkContentTicks,
      );
      const chunkWallDuration = chunkWallDurationTicks / TICKS_PER_SECOND;

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
      const IS_URGENT = timeUntilDeadline < 0.2;
      const bufferedDuration =
        this.nextScheduleTime - c.staging.startContextTime;

      // Just use same thresholds
      const TARGET_THRESHOLD = 2.0;
      const MIN_THRESHOLD = 0.1;

      if (IS_URGENT) {
        if (bufferedDuration >= MIN_THRESHOLD) await flushStagingBuffer();
      } else {
        if (bufferedDuration >= TARGET_THRESHOLD) await flushStagingBuffer();
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
