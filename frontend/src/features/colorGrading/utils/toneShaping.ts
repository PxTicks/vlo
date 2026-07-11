export interface ToneParameters {
  kneeThreshold: number;
  kneeSoftness: number;
  toeAmount: number;
  toeSoftness: number;
}

export type ToneMacro = "highlight" | "shadow";

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function highlightRolloffStrength(
  parameters: ToneParameters,
): number {
  if (parameters.kneeSoftness <= 0) return 0;
  const thresholdStrength = (1 - parameters.kneeThreshold) / 0.2;
  const transitionStrength = parameters.kneeSoftness / 0.3;
  return clampUnit((thresholdStrength + transitionStrength) / 2);
}

export function shadowLiftStrength(parameters: ToneParameters): number {
  if (parameters.toeAmount <= 0 || parameters.toeSoftness <= 0) return 0;
  return clampUnit(parameters.toeAmount);
}

export function toneMacroUpdate(
  macro: ToneMacro,
  strength: number,
): Partial<ToneParameters> {
  const value = clampUnit(strength);
  if (macro === "highlight") {
    return {
      kneeThreshold: 1 - 0.2 * value,
      kneeSoftness: 0.3 * value,
    };
  }
  return {
    toeAmount: value,
    toeSoftness: 0.5 * value,
  };
}
