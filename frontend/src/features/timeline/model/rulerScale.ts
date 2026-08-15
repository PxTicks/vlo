import { TICKS_PER_SECOND } from "../../../core/time/constants";
import { getTicksPerFrame } from "../../../core/time/ticksPerFrame";

/**
 * Which gradations the timeline ruler draws at a given zoom, and how they are
 * labelled. Pure — the ruler canvas asks for a scale, then walks it.
 *
 * The ladder runs from whole-hour steps down to a single frame and stops there:
 * a frame is the finest thing the timeline can address (every seek snaps to the
 * frame grid), so subdividing further would draw gradations no click can land
 * on. Sub-second steps are restricted to divisors of the project fps, which is
 * what keeps whole seconds *on* the ladder at every level — the second boundary
 * is always a labelled gradation, never a tick that falls between two.
 */

/** Gradations closer together than this are visual noise, so reject the step. */
const MIN_GRADATION_SPACING_PX = 12;
/** A label is ~30px of text ("00:04"); this leaves it clear air on both sides. */
const MIN_LABEL_SPACING_PX = 64;

/** The steps at or above one second, in seconds. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export interface RulerScale {
  /** Tick distance between gradations (the fine, mostly unlabelled marks). */
  gradationTicks: number;
  /** Tick distance between labelled gradations; always a multiple of the above. */
  labelTicks: number;
  /**
   * True once labels are closer together than a second, which is the only case
   * where a label cannot be a timecode: the marks between two whole seconds are
   * labelled as frame offsets ("2f", "4f") into the second they follow.
   */
  frameLabels: boolean;
}

function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

/**
 * Sub-second steps, in ticks: 1 frame, then every whole divisor of the frame
 * rate up to (but not including) a full second. Divisors only, so each step
 * tiles a second exactly — at 24fps: 1, 2, 3, 4, 6, 8, 12 frames.
 */
function frameStepsInTicks(fps: number): number[] {
  const ticksPerFrameValue = getTicksPerFrame(fps);
  const framesPerSecond = Math.round(TICKS_PER_SECOND / ticksPerFrameValue);
  const steps: number[] = [];
  for (let frames = 1; frames < framesPerSecond; frames++) {
    if (framesPerSecond % frames === 0) steps.push(frames * ticksPerFrameValue);
  }
  return steps;
}

/**
 * Pick the finest gradation that still reads at `pixelsPerSecond`, then the
 * finest *coarser* step that can carry labels. Labels are deliberately never
 * put on every gradation: the step between them is what makes the intermediate
 * marks unlabelled gradations, which is how the ruler stays legible when fully
 * zoomed in (whole seconds, even frames, bare marks for the odd frames).
 */
export function chooseRulerScale(
  pixelsPerSecond: number,
  fps: number,
): RulerScale {
  const steps = [
    ...frameStepsInTicks(fps),
    ...SECOND_STEPS.map((seconds) => seconds * TICKS_PER_SECOND),
  ];
  const scale = Math.max(pixelsPerSecond, Number.EPSILON);
  const spacingPx = (ticks: number) => (ticks / TICKS_PER_SECOND) * scale;

  const gradationTicks =
    steps.find((step) => spacingPx(step) >= MIN_GRADATION_SPACING_PX) ??
    steps[steps.length - 1];
  const labelTicks =
    steps.find(
      (step) =>
        step > gradationTicks &&
        isMultipleOf(step, gradationTicks) &&
        spacingPx(step) >= MIN_LABEL_SPACING_PX,
    ) ?? gradationTicks;

  return {
    gradationTicks,
    labelTicks,
    frameLabels: labelTicks < TICKS_PER_SECOND,
  };
}

function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}

/**
 * The text for a labelled gradation: `MM:SS` on whole seconds (`H:MM:SS` past
 * an hour), and the frame offset into the current second otherwise — so a
 * fully zoomed-in ruler reads `00:04, 2f, 4f, ... 00:05, 2f, ...`.
 */
export function formatRulerLabel(
  tick: number,
  fps: number,
  frameLabels: boolean,
): string {
  const seconds = tick / TICKS_PER_SECOND;
  const onWholeSecond = isMultipleOf(tick, TICKS_PER_SECOND);
  if (!frameLabels || onWholeSecond) return formatTimecode(seconds);

  const intoSecond = tick - Math.floor(seconds) * TICKS_PER_SECOND;
  return `${Math.round(intoSecond / getTicksPerFrame(fps))}f`;
}
