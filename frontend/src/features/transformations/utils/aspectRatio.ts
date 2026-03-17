import type { ScalarParameter } from "../types";

/**
 * Calculates the new value for a linked control based on the aspect ratio constraint.
 * 
 * @param currentVal The current value of the control being edited (before the new change).
 * @param otherVal The current value of the other linked control.
 * @param newVal The new value being committed for the control being edited.
 * @returns The calculated new value for the other control, or null if no change is needed.
 */
export function calculateLinkedValue(
  currentVal: number,
  otherVal: number,
  newVal: number
): number | null {
  // If current value is 0, we cannot calculate a ratio.
  if (currentVal === 0) {
      return null;
  }

  const ratio = otherVal / currentVal;
  const newOther = newVal * ratio;

  // Round to 3 decimal places to avoid standard floating point noises
  return Math.round(newOther * 1000) / 1000;
}

function getRepresentativeValue(param: ScalarParameter): number {
    if (typeof param === 'number') return param;
    if (param && typeof param === 'object' && param.type === 'spline') {
        return param.points[0]?.value ?? 0;
    }
    return 0;
}

export function calculateLinkedParameter(
    currentParam: ScalarParameter,
    otherParam: ScalarParameter,
    newParam: ScalarParameter
): ScalarParameter | null {
    const currentVal = getRepresentativeValue(currentParam);
    const otherVal = getRepresentativeValue(otherParam);

    if (currentVal === 0) return null;
    const ratio = otherVal / currentVal;

    // Case 1: New parameter is a Number
    if (typeof newParam === 'number') {
        const newOther = newParam * ratio;
        return Math.round(newOther * 1000) / 1000;
    }

    // Case 2: New parameter is a Spline
    // We "transfer the graph", meaning the other parameter inherits the same curve structure, just scaled.
    if (newParam && typeof newParam === 'object' && newParam.type === 'spline') {
        return {
            ...newParam,
            points: newParam.points.map(p => ({
                ...p,
                value: p.value * ratio
            }))
        };
    }

    return null;
}
