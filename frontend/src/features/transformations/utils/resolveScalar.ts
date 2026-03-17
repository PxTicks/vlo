import type { ScalarParameter } from "../types";
import { MonotoneCubicSpline } from "./MonotoneCubicSpline";

const splineCacheByParam = new WeakMap<object, MonotoneCubicSpline>();
const splineCacheByPointsKey = new Map<string, MonotoneCubicSpline>();

function getCachedSpline(param: { points: Array<{ time: number; value: number }> }) {
  const cachedByRef = splineCacheByParam.get(param);
  if (cachedByRef) return cachedByRef;

  const pointsKey = JSON.stringify(param.points);
  const cachedByKey = splineCacheByPointsKey.get(pointsKey);
  if (cachedByKey) {
    splineCacheByParam.set(param, cachedByKey);
    return cachedByKey;
  }

  const spline = new MonotoneCubicSpline(param.points);
  splineCacheByParam.set(param, spline);
  splineCacheByPointsKey.set(pointsKey, spline);
  return spline;
}

export function resolveScalar(param: ScalarParameter | undefined, time: number, defaultValue: number = 0): number {
  if (param === undefined || param === null) return defaultValue;

  if (typeof param === "number") {
    return param;
  }

  if (typeof param === "object" && param.type === "spline") {
    const spline = getCachedSpline(param);
    return spline.at(time);
  }

  return defaultValue;
}
