export interface ToneParameters {
  kneeThreshold: number;
  kneeSoftness: number;
  toeAmount: number;
  toeSoftness: number;
}

export interface ToneGraphParameters extends ToneParameters {
  contrast: number;
  pivot: number;
}

export type ToneMacro = "highlight" | "shadow";

/**
 * The knee ceiling the highlight macro starts from. Grades keep super-white
 * headroom past the tone stage (curves and stacked grades can pull it back into
 * range), so an engaged knee clips everything above its threshold. Starting
 * the ceiling at the top of the graph domain, rather than at 1.0, means the
 * first pixel of a drag no longer flattens the whole super-white range.
 */
export const KNEE_OFF_THRESHOLD = 1.5;
const KNEE_FULL_THRESHOLD = 0.8;
const KNEE_FULL_SOFTNESS = 0.3;
const KNEE_MAX_SOFTNESS = 0.5;
const TOE_FULL_SOFTNESS = 0.5;
const TOE_FULL_AMOUNT = 1;
const TOE_MAX_AMOUNT = 1;

/**
 * How far each macro's handle travels, in tone-domain units, between zero and
 * full strength. The highlight handle tracks the knee threshold and the shadow
 * handle tracks the toe transition.
 */
export const TONE_MACRO_SPAN: Readonly<Record<ToneMacro, number>> = {
  highlight: KNEE_OFF_THRESHOLD - KNEE_FULL_THRESHOLD,
  shadow: TOE_FULL_SOFTNESS,
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Unclamped macro position: 0 is inactive and 1 is the full macro. Exact
 * parameter edits can sit past 1, and drags starting there must not snap.
 */
export function toneMacroPosition(
  macro: ToneMacro,
  parameters: ToneParameters,
): number {
  if (macro === "highlight") {
    if (parameters.kneeSoftness <= 0) return 0;
    return Math.max(
      0,
      (KNEE_OFF_THRESHOLD - parameters.kneeThreshold) /
        TONE_MACRO_SPAN.highlight,
    );
  }
  if (parameters.toeAmount <= 0 || parameters.toeSoftness <= 0) return 0;
  return parameters.toeSoftness / TONE_MACRO_SPAN.shadow;
}

export function toneMacroStrength(
  macro: ToneMacro,
  parameters: ToneParameters,
): number {
  return clampUnit(toneMacroPosition(macro, parameters));
}

/** The knee threshold the graph draws; an inactive knee sits at the top. */
export function effectiveKneeThreshold(parameters: ToneParameters): number {
  return parameters.kneeSoftness > 0
    ? parameters.kneeThreshold
    : KNEE_OFF_THRESHOLD;
}

/** The toe transition the graph draws; an inactive toe sits at the origin. */
export function effectiveToeSoftness(parameters: ToneParameters): number {
  return toneMacroPosition("shadow", parameters) * TONE_MACRO_SPAN.shadow;
}

/** Positions a gesture may reach: the macro range, widened to its start. */
export function toneMacroRange(
  macro: ToneMacro,
  start: ToneParameters,
): { min: number; max: number } {
  return { min: 0, max: Math.max(1, toneMacroPosition(macro, start)) };
}

/**
 * The partner parameter (knee transition or toe amount) at a macro position,
 * continuous from the gesture's start for any starting values:
 * 1. Towards inactive, it scales in proportion down to zero at position 0.
 * 2. Towards full, it interpolates to the full macro's value at position 1.
 * Starting values on the default macro line reproduce that line exactly.
 */
function partnerValue(
  position: number,
  startPosition: number,
  startPartner: number,
  fullPartner: number,
): number {
  if (position < startPosition) {
    return (startPartner * position) / startPosition;
  }
  if (startPosition >= 1) return startPartner;
  const progress = (position - startPosition) / (1 - startPosition);
  return startPartner + (fullPartner - startPartner) * progress;
}

/**
 * Parameters for a macro position. The handle-tracked parameter follows the
 * position exactly; its partner continues smoothly from the gesture's start
 * (see `partnerValue`), so exact values off the default macro line never snap
 * onto it.
 */
export function toneMacroUpdate(
  macro: ToneMacro,
  position: number,
  start?: ToneParameters,
): Partial<ToneParameters> {
  const value = Math.max(0, position);
  const startPosition = start ? toneMacroPosition(macro, start) : 0;
  if (macro === "highlight") {
    const softness = partnerValue(
      value,
      startPosition,
      start?.kneeSoftness ?? 0,
      KNEE_FULL_SOFTNESS,
    );
    return {
      kneeThreshold: KNEE_OFF_THRESHOLD - TONE_MACRO_SPAN.highlight * value,
      kneeSoftness: Math.min(KNEE_MAX_SOFTNESS, softness),
    };
  }
  const amount = partnerValue(
    value,
    startPosition,
    start?.toeAmount ?? 0,
    TOE_FULL_AMOUNT,
  );
  return {
    toeAmount: Math.min(TOE_MAX_AMOUNT, amount),
    toeSoftness: TONE_MACRO_SPAN.shadow * value,
  };
}
