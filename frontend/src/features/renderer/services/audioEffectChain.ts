import { resolveScalar, isAudioEffectType } from "../../transformations";
import type {
  ScalarParameter,
  AudioEffectTransform,
  PanTransform,
  EqTransform,
  CompressorTransform,
  ReverbTransform,
  DelayTransform,
} from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";

/**
 * Audio effect chain
 *
 * Translates a clip's enabled audio-effect transforms (pan, EQ, compressor,
 * reverb, delay) into a chain of Web Audio nodes. The chain is built once per
 * clip occurrence and **persists across scheduling chunks** so stateful effects
 * (compressor envelopes, reverb/delay tails) keep continuity. Each chunk the
 * renderer only (a) connects the chunk's gain node into `inputNode` and (b)
 * calls `scheduleAutomation` to (re)schedule the parameter automation for that
 * window — mirroring how the volume curve is scheduled in TrackAudioRenderer.
 */

/** Window describing the chunk currently being scheduled. */
export interface AudioEffectAutomationWindow {
  /** Context time at which this chunk begins playing. */
  startContextTime: number;
  /** Wall-clock duration of the chunk, in seconds. */
  wallDurationSeconds: number;
  /** Presentation tick at the start of the chunk. */
  startTargetTicks: number;
  /** Presentation-tick span covered by the chunk. */
  windowTicks: number;
  /** Number of samples to use when materializing a spline curve. */
  sampleCount: number;
  /**
   * Maps a presentation tick to source-media time in project ticks. Supplied by
   * the renderer so splined effect params use the same media-owned keyframe
   * domain as volume.
   */
  sourceTimeTicksAt: (presentationTick: number) => number;
}

export interface AudioEffectChain {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  /** Topology hash; the renderer rebuilds the chain when this changes. */
  readonly signature: string;
  scheduleAutomation(
    window: AudioEffectAutomationWindow,
    transforms: AudioEffectTransform[],
  ): void;
  dispose(): void;
}

interface EffectSegment {
  type: AudioEffectTransform["type"];
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
  schedule(
    window: AudioEffectAutomationWindow,
    transform: AudioEffectTransform,
  ): void;
}

// -----------------------------------------------------------------------------
// Parameter scheduling helpers
// -----------------------------------------------------------------------------

/**
 * Schedule a (possibly splined) scalar onto an AudioParam over the chunk window.
 * Constant params use a single point event; splined params materialize a value
 * curve (same approach as the volume curve), with a stepped fallback if the
 * browser rejects the curve.
 */
function scheduleScalar(
  param: AudioParam,
  value: ScalarParameter | undefined,
  defaultValue: number,
  window: AudioEffectAutomationWindow,
  map: (v: number) => number = (v) => v,
): void {
  if (value === undefined || typeof value === "number") {
    param.setValueAtTime(map(value ?? defaultValue), window.startContextTime);
    return;
  }

  const { sampleCount } = window;
  const curve = new Float32Array(sampleCount);
  const step = window.windowTicks / Math.max(1, sampleCount - 1);
  for (let i = 0; i < sampleCount; i++) {
    const t = window.startTargetTicks + i * step;
    curve[i] = map(
      resolveScalar(value, window.sourceTimeTicksAt(t), defaultValue),
    );
  }

  try {
    param.setValueCurveAtTime(
      curve,
      window.startContextTime,
      window.wallDurationSeconds,
    );
  } catch {
    param.setValueAtTime(curve[0], window.startContextTime);
  }
}

/** Resolve a scalar at the chunk start (for params we don't smoothly automate). */
function scalarAtStart(
  value: ScalarParameter | undefined,
  defaultValue: number,
  window: AudioEffectAutomationWindow,
): number {
  return resolveScalar(
    value,
    window.sourceTimeTicksAt(window.startTargetTicks),
    defaultValue,
  );
}

// -----------------------------------------------------------------------------
// Procedural reverb impulse response
// -----------------------------------------------------------------------------

const irCache = new Map<string, AudioBuffer>();

/** Small deterministic PRNG so impulse responses are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate (and cache) a stereo impulse response: decaying white noise. Keyed
 * by sample rate + decay so it is deterministic and reusable across the
 * per-export-chunk OfflineAudioContexts (AudioBuffers are not context-bound).
 */
export function getReverbImpulseResponse(
  ctx: BaseAudioContext,
  decaySeconds: number,
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const decay = Math.max(0.05, decaySeconds);
  const key = `${sampleRate}:${decay.toFixed(2)}`;
  const cached = irCache.get(key);
  if (cached) return cached;

  const length = Math.max(1, Math.floor(sampleRate * decay));
  const ir = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(length ^ (ch * 0x9e3779b9));
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (rand() * 2 - 1) * Math.pow(1 - t, 2.5);
    }
  }

  irCache.set(key, ir);
  return ir;
}

// -----------------------------------------------------------------------------
// Per-effect node builders
// -----------------------------------------------------------------------------

function buildPan(ctx: BaseAudioContext): EffectSegment {
  const node = ctx.createStereoPanner();
  return {
    type: "pan",
    input: node,
    output: node,
    nodes: [node],
    schedule: (w, transform) => {
      const p = (transform as PanTransform).parameters;
      scheduleScalar(node.pan, p.pan, 0, w);
    },
  };
}

function buildEq(ctx: BaseAudioContext): EffectSegment {
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.Q.value = 1;
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  low.connect(mid);
  mid.connect(high);
  return {
    type: "audioEq",
    input: low,
    output: high,
    nodes: [low, mid, high],
    schedule: (w, transform) => {
      const p = (transform as EqTransform).parameters;
      low.frequency.setValueAtTime(
        scalarAtStart(p.lowFreq, 200, w),
        w.startContextTime,
      );
      mid.frequency.setValueAtTime(
        scalarAtStart(p.midFreq, 1000, w),
        w.startContextTime,
      );
      high.frequency.setValueAtTime(
        scalarAtStart(p.highFreq, 4000, w),
        w.startContextTime,
      );
      scheduleScalar(low.gain, p.lowGain, 0, w);
      scheduleScalar(mid.gain, p.midGain, 0, w);
      scheduleScalar(high.gain, p.highGain, 0, w);
    },
  };
}

function buildCompressor(ctx: BaseAudioContext): EffectSegment {
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.connect(makeup);
  return {
    type: "compressor",
    input: comp,
    output: makeup,
    nodes: [comp, makeup],
    schedule: (w, transform) => {
      const p = (transform as CompressorTransform).parameters;
      comp.threshold.setValueAtTime(
        scalarAtStart(p.threshold, -24, w),
        w.startContextTime,
      );
      comp.ratio.setValueAtTime(scalarAtStart(p.ratio, 4, w), w.startContextTime);
      comp.attack.setValueAtTime(
        scalarAtStart(p.attack, 0.003, w),
        w.startContextTime,
      );
      comp.release.setValueAtTime(
        scalarAtStart(p.release, 0.25, w),
        w.startContextTime,
      );
      comp.knee.setValueAtTime(scalarAtStart(p.knee, 30, w), w.startContextTime);
      scheduleScalar(makeup.gain, p.makeup, 1, w);
    },
  };
}

function buildReverb(ctx: BaseAudioContext): EffectSegment {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  const output = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  input.connect(conv);
  conv.connect(wet);
  wet.connect(output);

  let lastIrKey = "";
  return {
    type: "reverb",
    input,
    output,
    nodes: [input, dry, wet, conv, output],
    schedule: (w, transform) => {
      const p = (transform as ReverbTransform).parameters;
      const decay = Math.max(0.05, scalarAtStart(p.decay, 2, w));
      const key = `${ctx.sampleRate}:${decay.toFixed(2)}`;
      if (key !== lastIrKey) {
        conv.buffer = getReverbImpulseResponse(ctx, decay);
        lastIrKey = key;
      }
      scheduleScalar(wet.gain, p.mix, 0.3, w);
      scheduleScalar(dry.gain, p.mix, 0.3, w, (v) => 1 - v);
    },
  };
}

function buildDelay(ctx: BaseAudioContext): EffectSegment {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const output = ctx.createGain();
  const delay = ctx.createDelay(1.0);
  const feedback = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  input.connect(delay);
  delay.connect(wet);
  wet.connect(output);
  delay.connect(feedback);
  feedback.connect(delay);
  return {
    type: "delay",
    input,
    output,
    nodes: [input, dry, wet, output, delay, feedback],
    schedule: (w, transform) => {
      const p = (transform as DelayTransform).parameters;
      scheduleScalar(delay.delayTime, p.time, 0.3, w);
      scheduleScalar(feedback.gain, p.feedback, 0.4, w);
      scheduleScalar(wet.gain, p.mix, 0.3, w);
      scheduleScalar(dry.gain, p.mix, 0.3, w, (v) => 1 - v);
    },
  };
}

function buildSegment(
  ctx: BaseAudioContext,
  transform: AudioEffectTransform,
): EffectSegment | null {
  switch (transform.type) {
    case "pan":
      return buildPan(ctx);
    case "audioEq":
      return buildEq(ctx);
    case "compressor":
      return buildCompressor(ctx);
    case "reverb":
      return buildReverb(ctx);
    case "delay":
      return buildDelay(ctx);
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Ordered, enabled audio-effect transforms on a clip. */
export function getAudioEffectTransforms(
  clip: TimelineClip,
): AudioEffectTransform[] {
  return (clip.transformations || []).filter(
    (t): t is AudioEffectTransform => t.isEnabled && isAudioEffectType(t.type),
  );
}

/** Topology signature: rebuild the chain when this changes. */
export function computeAudioEffectSignature(
  transforms: AudioEffectTransform[],
): string {
  return transforms.map((t) => t.type).join(">");
}

function scalarParameterMax(
  value: ScalarParameter | undefined,
  defaultValue: number,
): number {
  if (typeof value === "number") return value;
  if (value?.type === "spline") {
    return value.points.reduce(
      (max, point) =>
        typeof point.value === "number" && Number.isFinite(point.value)
          ? Math.max(max, point.value)
          : max,
      defaultValue,
    );
  }
  return defaultValue;
}

/**
 * Conservative tail-time estimate for deciding when a scheduled chain is safe
 * to disconnect. This is lifecycle policy, not DSP: it deliberately errs on
 * retaining a chain a little longer so realtime preview does not chop tails.
 */
export function estimateAudioEffectTailSeconds(
  transforms: AudioEffectTransform[],
): number {
  let tailSeconds = 0;

  for (const transform of transforms) {
    if (transform.type === "reverb") {
      const p = (transform as ReverbTransform).parameters;
      tailSeconds = Math.max(
        tailSeconds,
        Math.max(0.05, scalarParameterMax(p.decay, 2)),
      );
      continue;
    }

    if (transform.type === "delay") {
      const p = (transform as DelayTransform).parameters;
      const delayTime = Math.min(
        1,
        Math.max(0, scalarParameterMax(p.time, 0.3)),
      );
      const feedback = Math.min(
        0.95,
        Math.max(0, scalarParameterMax(p.feedback, 0.4)),
      );
      const repeats =
        feedback <= 0.001
          ? 1
          : Math.ceil(Math.log(0.001) / Math.log(feedback));
      tailSeconds = Math.max(
        tailSeconds,
        Math.min(10, delayTime * Math.max(1, repeats)),
      );
      continue;
    }

    if (transform.type === "compressor") {
      const p = (transform as CompressorTransform).parameters;
      tailSeconds = Math.max(
        tailSeconds,
        Math.max(0, scalarParameterMax(p.release, 0.25)),
      );
    }
  }

  return tailSeconds;
}

/**
 * Build the audio effect chain for a clip's transforms against `ctx`. Returns
 * null when there are no audio effects (callers then route the gain node
 * straight to the destination, leaving volume-only clips unchanged).
 */
export function buildAudioEffectChain(
  ctx: BaseAudioContext,
  transforms: AudioEffectTransform[],
): AudioEffectChain | null {
  if (transforms.length === 0) return null;

  const segments: EffectSegment[] = [];
  for (const transform of transforms) {
    const segment = buildSegment(ctx, transform);
    if (segment) segments.push(segment);
  }
  if (segments.length === 0) return null;

  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].output.connect(segments[i + 1].input);
  }

  let disposed = false;
  return {
    inputNode: segments[0].input,
    outputNode: segments[segments.length - 1].output,
    signature: computeAudioEffectSignature(transforms),
    scheduleAutomation: (window, currentTransforms) => {
      if (disposed) return;
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const transform = currentTransforms[i];
        if (!transform || transform.type !== segment.type) continue;
        segment.schedule(window, transform);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const segment of segments) {
        for (const node of segment.nodes) {
          try {
            node.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}
