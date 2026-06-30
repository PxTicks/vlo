import type {
  ExtensionCompiledInterpolationSegment,
  ExtensionCompiledScalarSource,
  ExtensionKeyframedScalarParameter,
} from "../../extensions/types";
import {
  CORE_MONOTONE_INTERPOLATION_ID,
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
} from "../animation";
import type { ScalarParameter, SplineParameter } from "../types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isSplineParameter,
} from "../types";

interface CompiledKeyframedScalar {
  readonly segments: readonly ExtensionCompiledInterpolationSegment[];
  sample(time: number): number;
  dispose(): void;
}

interface DisposableCompiled {
  dispose(): void;
}

class CompiledLruCache<TCompiled extends DisposableCompiled> {
  private readonly values = new Map<string, TCompiled>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): TCompiled | undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: TCompiled): void {
    const previous = this.values.get(key);
    if (previous && previous !== value) previous.dispose();
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldestKey = this.values.keys().next().value;
      if (oldestKey === undefined) break;
      this.values.get(oldestKey)?.dispose();
      this.values.delete(oldestKey);
    }
  }

  clear(): void {
    this.values.forEach((value) => value.dispose());
    this.values.clear();
  }
}

const scalarSourceCache = new CompiledLruCache<ExtensionCompiledScalarSource>(128);
const keyframedCache = new CompiledLruCache<CompiledKeyframedScalar>(256);
const legacySplineCache =
  new CompiledLruCache<ExtensionCompiledInterpolationSegment>(256);

extensionScalarSourceRegistry.subscribe(() => scalarSourceCache.clear());
extensionInterpolationRegistry.subscribe(() => {
  keyframedCache.clear();
  legacySplineCache.clear();
});

function splitContributionId(id: string): { extensionId: string; typeId: string } {
  const separator = id.indexOf("/");
  return {
    extensionId: id.slice(0, separator),
    typeId: id.slice(separator + 1),
  };
}

function coreMonotonePayload() {
  const { extensionId, typeId } = splitContributionId(
    CORE_MONOTONE_INTERPOLATION_ID,
  );
  return {
    extensionId,
    typeId,
    schemaVersion: 1,
    data: null,
  } as const;
}

function getLegacySpline(param: SplineParameter): ExtensionCompiledInterpolationSegment {
  const key = JSON.stringify(param);
  const cached = legacySplineCache.get(key);
  if (cached) return cached;

  const keyframes = param.points.map(({ time, value }, index) => ({
    time,
    value,
    outgoing: index < param.points.length - 1 ? coreMonotonePayload() : undefined,
  }));
  const compiled = extensionInterpolationRegistry.compile(
    coreMonotonePayload(),
    keyframes,
    0,
  );
  legacySplineCache.set(key, compiled);
  return compiled;
}

function assertKeyframes(value: ExtensionKeyframedScalarParameter): void {
  if (value.keyframes.length === 0) {
    throw new Error("An extension keyframed scalar must contain a keyframe.");
  }
  let previousTime = Number.NEGATIVE_INFINITY;
  value.keyframes.forEach((keyframe, index) => {
    if (!Number.isFinite(keyframe.time) || !Number.isFinite(keyframe.value)) {
      throw new Error("Extension scalar keyframes must contain finite values.");
    }
    if (keyframe.time <= previousTime) {
      throw new Error("Extension scalar keyframes must be strictly time-ordered.");
    }
    if (index < value.keyframes.length - 1 && !keyframe.outgoing) {
      throw new Error(`Extension scalar segment ${index} has no interpolation provider.`);
    }
    previousTime = keyframe.time;
  });
}

function findSegmentIndex(
  keyframes: ExtensionKeyframedScalarParameter["keyframes"],
  time: number,
): number {
  let low = 0;
  let high = keyframes.length - 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (time < keyframes[middle].time) {
      high = middle - 1;
    } else if (time > keyframes[middle + 1].time) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return Math.max(0, Math.min(keyframes.length - 2, low));
}

function compileKeyframedScalar(
  value: ExtensionKeyframedScalarParameter,
): CompiledKeyframedScalar {
  assertKeyframes(value);
  const segments: ExtensionCompiledInterpolationSegment[] = [];
  try {
    for (let index = 0; index < value.keyframes.length - 1; index += 1) {
      const interpolation = value.keyframes[index].outgoing;
      if (!interpolation) {
        throw new Error(`Extension scalar segment ${index} has no interpolation provider.`);
      }
      segments.push(
        extensionInterpolationRegistry.compile(
          interpolation,
          value.keyframes,
          index,
        ),
      );
    }
  } catch (error) {
    segments.forEach((segment) => segment.dispose());
    throw error;
  }

  return {
    segments,
    sample: (time: number): number => {
      const first = value.keyframes[0];
      const last = value.keyframes[value.keyframes.length - 1];
      if (value.keyframes.length === 1 || time <= first.time) return first.value;
      if (time >= last.time) return last.value;
      return segments[findSegmentIndex(value.keyframes, time)].sample(time);
    },
    dispose: () => segments.forEach((segment) => segment.dispose()),
  };
}

function getKeyframedScalar(
  value: ExtensionKeyframedScalarParameter,
): CompiledKeyframedScalar {
  const key = JSON.stringify(value);
  const cached = keyframedCache.get(key);
  if (cached) return cached;
  const compiled = compileKeyframedScalar(value);
  keyframedCache.set(key, compiled);
  return compiled;
}

export function getCompiledScalarSource(
  param: ScalarParameter,
): ExtensionCompiledScalarSource | undefined {
  if (!isExtensionScalarSourceParameter(param)) return undefined;
  const key = JSON.stringify(param);
  const cached = scalarSourceCache.get(key);
  if (cached) return cached;
  const compiled = extensionScalarSourceRegistry.compile(param.source);
  scalarSourceCache.set(key, compiled);
  return compiled;
}

/**
 * Random-access scalar evaluation shared by preview, render, export, audio,
 * and graph previews. Provider failures fail closed to the caller's default.
 */
export function resolveScalar(
  param: ScalarParameter | undefined,
  time: number,
  defaultValue: number = 0,
  context: Readonly<{ durationTicks?: number; extrapolate?: boolean }> = {},
): number {
  if (param === undefined || param === null) return defaultValue;
  if (typeof param === "number") return param;

  try {
    let value: number;
    if (isSplineParameter(param)) {
      value = getLegacySpline(param).sample(time);
    } else if (isExtensionScalarSourceParameter(param)) {
      value = getCompiledScalarSource(param)!.sample(time, {
        durationTicks: context.durationTicks,
        extrapolate: context.extrapolate ?? true,
      });
    } else if (isExtensionKeyframedScalarParameter(param)) {
      value = getKeyframedScalar(param).sample(time);
    } else {
      return defaultValue;
    }
    return Number.isFinite(value) ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}
