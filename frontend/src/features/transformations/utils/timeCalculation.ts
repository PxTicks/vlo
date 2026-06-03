import type { TimelineClip, ClipTransform } from "../../../types/TimelineTypes";
import type { ScalarParameter, SplinePoint, SpeedTransform } from "../types";
import { MonotoneCubicSpline } from "./MonotoneCubicSpline";
import { TICKS_PER_SECOND } from "../../timeline/constants";

/**
 * Low-level tick engine for clip-local visual time <-> source-media time.
 * Feature code should prefer `clipTimeDomains` so presentation time,
 * adjustment-effective time, clip-local visual time, and source-media time are
 * named explicitly at the boundary.
 */

// Cache for Spline Objects to avoid re-creation/sorting overhead
const splineObjectCache = new Map<string, MonotoneCubicSpline>();

/**
 * Calculates the 'Effective Source Time' for a given clip at a specific local playback time.
 * * REFACTOR: Operates in Absolute Coordinates.
 * Input: localTime (relative to clip visual start)
 * Process: Converts to Absolute Visual Time (by adding crop), then Pulls back to Source.
 */
export function calculateClipTime(
  clip: TimelineClip,
  localTime: number,
  extrapolate: boolean = true,
): number {
  // 1. Calculate Absolute Visual Time (Time relative to the 'zero' of the transformed stream)
  // This accounts for the crop "visually" shifting the clip.
  const absoluteVisualTime = localTime + (clip.transformedOffset || 0);

  // 2. Pull this time back through the stack to get Absolute Source Time
  return pullTimeThroughTransforms(
    clip.transformations || [],
    absoluteVisualTime,
    extrapolate,
  );
}

/**
 * Generalized Helper: Calculates the content duration consumed by ANY arbitrary visual segment.
 */
export function getSegmentContentDuration(
  clip: TimelineClip,
  startTicks: number, // Relative to Visual Start
  durationTicks: number,
): number {
  const t0 = (clip.transformedOffset || 0) + startTicks;
  const t1 = t0 + durationTicks;

  const map0 = pullTimeThroughTransforms(clip.transformations || [], t0, true);
  const map1 = pullTimeThroughTransforms(clip.transformations || [], t1, true);

  return map1 - map0;
}

/**
 * Helper to pull an ABSOLUTE Time BACKWARDS through the transformation stack.
 * * @param transforms The transformation stack
 * @param absoluteTime The time at the output of the stack (Absolute Transformed Time)
 * @param extrapolate Whether to extrapolate beyond spline bounds
 * @returns Absolute Source Time (Input to the bottom of the stack)
 */
export function pullTimeThroughTransforms(
  transforms: ClipTransform[],
  absoluteTime: number,
  extrapolate: boolean = true,
): number {
  if (!transforms || transforms.length === 0) return absoluteTime;

  // Iterate Right-to-Left (Timeline -> Source)
  // We assume 'pulledTime' is always in the Time Domain of the OUTPUT of the current layer.
  // We want to map it to the INPUT of the current layer.
  return transforms.reduceRight((pulledTime, transform) => {
    if (!transform.isEnabled) return pulledTime;

    if (transform.type === "speed") {
      const speedParams = (transform as SpeedTransform).parameters;

      return getIdempotentTimeMap(speedParams.factor, pulledTime, extrapolate);
    }

    // Non-speed transforms (Position, Scale) do not alter time flow.
    // Input Time = Output Time.
    return pulledTime;
  }, absoluteTime);
}

/**
 * Helper to push an ABSOLUTE Source Time FORWARD through the transformation stack.
 * * @param transforms The transformation stack
 * @param sourceTime Absolute Source Time
 * @returns Absolute Transformed Time (at the end of the stack)
 */
export function pushTimeThroughTransforms(
  transforms: ClipTransform[],
  sourceTime: number,
): number {
  if (!transforms || transforms.length === 0) return sourceTime;

  // Iterate Left-to-Right (Source -> Timeline)
  return transforms.reduce((pushedTime, transform) => {
    if (!transform.isEnabled) return pushedTime;

    if (transform.type === "speed") {
      const speedParams = (transform as SpeedTransform).parameters;

      // Inverse of Scalar: T_out = T_in / k
      if (typeof speedParams.factor === "number") {
        const k = speedParams.factor;
        if (Math.abs(k) < 1e-6) return pushedTime;
        return pushedTime / k;
      }

      // Inverse of Spline (Input -> Output)
      // We have t_in (pushedTime). We want t_out.
      // T_out = Integral(1/Speed(t)) dt
      if (speedParams.factor && speedParams.factor.type === "spline") {
        // Let's use the cached inverse spline (Map: Timeline -> Source)
        // We have Source (pushedTime). We want Timeline.
        // Timeline = InverseSpline_Inverse(Source).
        // Since `InverseSpline` is X=Timeline, Y=Source.
        // We need to find X given Y.

        const inverseSpline = getInverseSpeedSpline(speedParams.factor.points);

        // Note on units: Splines are in TICKS.
        const sourceSeconds = pushedTime;

        // solveX expects Y value, returns X value.
        // Y = Source, X = Timeline.
        const mappedSeconds = inverseSpline.solveX
          ? inverseSpline.solveX(sourceSeconds)
          : 0; // Fallback if method missing

        return mappedSeconds;
      }
    }
    return pushedTime;
  }, sourceTime);
}

/**
 * Generic helper to map Time A -> Time B based on Speed Param.
 * Used primarily for PULLING (Timeline -> Source).
 * * - Scalar: returns time * factor (Input = Output * Factor)
 * - Spline: Maps Output -> Input via Inverse Spline
 */
export function getIdempotentTimeMap(
  param: ScalarParameter,
  outputTime: number,
  extrapolate: boolean = true,
): number {
  if (typeof param === "number") {
    return outputTime * param;
  }

  if (param && param.type === "spline") {
    const inverseSpline = getInverseSpeedSpline(param.points);
    // InverseSpline: X=Timeline(Output), Y=Source(Input)
    // We provide X, get Y.
    const effectiveSeconds = inverseSpline.at(outputTime, extrapolate);
    return effectiveSeconds;
  }

  return outputTime;
}

function getInverseSpeedSpline(points: SplinePoint[]): MonotoneCubicSpline {
  const key = "SPEED_INV_" + JSON.stringify(points);
  let inverseSpline = splineObjectCache.get(key);

  if (!inverseSpline) {
    inverseSpline = createInverseSpeedSpline(points);
    splineObjectCache.set(key, inverseSpline);
  }
  return inverseSpline;
}

function createInverseSpeedSpline(points: SplinePoint[]): MonotoneCubicSpline {
  const speedSpline = new MonotoneCubicSpline(points);

  // 1. Get max source time (This is now in TICKS, e.g., 240,000 for 5 seconds)
  const maxSourceTime = points[points.length - 1].time;

  // 2. DANGER ZONE FIX: Calculate steps based on PHYSICAL DURATION, not raw tick value.
  //    If we used maxSourceTime * 5 here, we would loop ~1.2 million times for a 5s clip.
  //    We maintain the original resolution density (~5 samples per second).
  const INTEGRATION_SAMPLES_PER_SEC = 5;
  const durationSeconds = maxSourceTime / TICKS_PER_SECOND;

  // We keep the minimum of 100 steps to ensure smoothness for very short clips
  const steps = Math.max(
    100,
    Math.ceil(durationSeconds * INTEGRATION_SAMPLES_PER_SEC),
  );

  const reversePoints: SplinePoint[] = [];
  let currentTimelineTime = 0;
  let prevSourceTime = 0;

  // 0,0 is valid in both domains (0 ticks = 0 ticks)
  reversePoints.push({ time: 0, value: 0 });

  for (let i = 1; i <= steps; i++) {
    // tSource is calculated in TICKS
    const tSource = (i / steps) * maxSourceTime;

    // dt is in TICKS
    const dt = tSource - prevSourceTime;

    const midT = prevSourceTime + dt / 2;

    // speed is a unitless scalar (Multiplier), so no conversion needed.
    const speed = Math.max(0.01, speedSpline.at(midT));

    // dTimeline = Ticks / Scalar = TICKS
    const dTimeline = dt / speed;
    currentTimelineTime += dTimeline;

    // Map: X=Timeline(Output Ticks), Y=Source(Input Ticks)
    reversePoints.push({ time: currentTimelineTime, value: tSource });
    prevSourceTime = tSource;
  }

  return new MonotoneCubicSpline(reversePoints);
}

export function getInstantaneousSpeed(
  clip: TimelineClip,
  localTime: number,
): number {
  const dt = 100;
  const t0 = Math.max(0, localTime - dt);
  const t1 = localTime + dt;

  const c0 = calculateClipTime(clip, t0);
  const c1 = calculateClipTime(clip, t1);

  const deltaContent = c1 - c0;
  const deltaTimeline = t1 - t0;

  if (deltaTimeline === 0) return 1.0;
  return deltaContent / deltaTimeline;
}

/**
 * Solves: Given a visual start time and content duration, how long is the visual duration?
 */
export function solveTimelineDuration(
  clip: TimelineClip,
  startTicks: number,
  contentTicks: number,
): number {
  // 1. Calculate Absolute Visual Start (including Crop)
  // This represents the specific point on the transformed timeline where we start.
  // "Where on the timeline are we starting?"
  const absVisualStart = (clip.transformedOffset || 0) + startTicks;

  // 2. Map Visual Start -> Absolute Source Start
  // "Where in the original source file is this point?"
  const absSourceStart = pullTimeThroughTransforms(
    clip.transformations || [],
    absVisualStart,
    true,
  );

  // 3. Determine Target Source End
  // "We want to play exactly this much more source content."
  const absSourceEnd = absSourceStart + contentTicks;

  // 4. Map Source End -> Absolute Visual End
  // "Where on the timeline does this source point land?"
  // Note: pushTimeThroughTransforms handles the non-linear math for Splines/Speed Ramps
  // by using the inverse of the speed function.
  const absVisualEnd = pushTimeThroughTransforms(
    clip.transformations || [],
    absSourceEnd,
  );

  // 5. The difference is the required Visual Duration (in Ticks)
  return absVisualEnd - absVisualStart;
}

/**
 * Maps absolute source/input time directly to clip-local visual time.
 * This is used for overlay items that stay locked to source time even when
 * downstream speed transforms reshape their on-screen position.
 */
export function mapSourceTimeToVisualTime(
  clip: TimelineClip,
  sourceTime: number,
): number {
  return (
    pushTimeThroughTransforms(clip.transformations || [], sourceTime) -
    (clip.transformedOffset || 0)
  );
}
