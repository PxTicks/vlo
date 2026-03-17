import type { SplineParameter } from "../types";

export function isSplineParameter(value: unknown): value is SplineParameter {
    return (
        typeof value === 'object' && 
        value !== null && 
        'type' in value && 
        (value as { type: string }).type === "spline" &&
        'points' in value &&
        Array.isArray((value as { points: unknown }).points)
    );
}
