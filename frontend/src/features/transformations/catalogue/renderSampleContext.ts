import type {
  FilterRenderContext,
  FilterRenderMode,
} from "./types";

/**
 * Monotonic host-generated sample identity. It must never be derived from
 * floating-point seconds, so a plain integer counter is the source of truth for
 * synthesized samples. The renderer supplies its own IDs on the frame path;
 * this counter only backs callers that have no timing to certify.
 */
let nextSyntheticSampleId = 1;

/**
 * Copy and freeze a host render sample before it crosses the trusted-extension
 * boundary. `readonly` protects TypeScript callers only; the runtime freeze
 * prevents one filter from changing the sample observed by a later filter in
 * the same applicator pass.
 */
export function createImmutableFilterRenderContext(
  context: FilterRenderContext,
): FilterRenderContext {
  return Object.freeze({ ...context });
}

/**
 * Build a safe, stateless render sample for a caller that cannot certify
 * timeline continuity. Each call gets a fresh `sampleId` under sequence `0`
 * with `initial` continuity, so a `none`-dependency filter is unaffected and a
 * temporal filter treats it as a discontinuous cold sample rather than silently
 * advancing feedback from an unrelated frame.
 */
export function createStatelessFilterRenderContext(
  overrides?: Partial<FilterRenderContext>,
): FilterRenderContext {
  return Object.freeze({
    sequenceId: 0,
    sampleId: nextSyntheticSampleId++,
    mode: "preview",
    continuity: "initial",
    presentationTimeTicks: 0,
    visualTimeTicks: 0,
    sourceTimeTicks: 0,
    deltaTimeTicks: null,
    fps: 0,
    isWarmup: false,
    ...overrides,
  });
}

/**
 * Build the render sample for a live/export frame. The presentation tick is the
 * project output sample, so it doubles as a stable, non-floating-point
 * `sampleId`: two clips in one frame and a repeated paused render at the same
 * tick observe the same identity, while moving the playhead changes it. Visual
 * and source times are seeded from the presentation tick; the clip applicator
 * overrides them with its resolved pre-speed visual time and post-speed source
 * time, and the offscreen effect-mask path consumes them directly.
 *
 * This is the compatibility fallback for renderer callers that have not joined
 * the frame coordinator. The coordinated preview/export/still paths override it
 * with host-certified sequence, continuity, delta, and warm-up metadata.
 */
export function createFrameFilterRenderContext(
  presentationTimeTicks: number,
  fps: number,
  mode: FilterRenderMode,
): FilterRenderContext {
  const tick = Math.round(presentationTimeTicks);
  return Object.freeze({
    sequenceId: 0,
    sampleId: tick,
    mode,
    continuity: "sequential",
    presentationTimeTicks: tick,
    visualTimeTicks: tick,
    sourceTimeTicks: tick,
    deltaTimeTicks: null,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
    isWarmup: false,
  });
}
