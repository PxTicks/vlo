import {
  TransformationSystem,
  dispatchTransform,
} from "./catalogue/TransformationRegistry";
import { getBaseLayout } from "./catalogue/layout/layoutDefinition";
import { Texture } from "pixi.js";
import type { ClipTransformTarget, TransformState } from "./catalogue/types";
import type { TimelineClip } from "../../types/TimelineTypes";
import { getIdempotentTimeMap } from "./utils/timeCalculation";
import { resolveScalar } from "./utils/resolveScalar";
import type { ScalarParameter } from "./types";
import { liveParamStore } from "./services/liveParamStore";
import { livePreviewParamStore } from "./services/livePreviewParamStore";

export interface ApplyClipTransformsOptions {
  baseLayoutMode?: "contain" | "origin";
  notifyLiveParams?: boolean;
}

function isSizeLike(value: unknown): value is { width: number; height: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "width" in value &&
    "height" in value &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function getTargetTextureSize(
  target: ClipTransformTarget,
): { width: number; height: number } | null {
  const maybeTexture = (target as { texture?: unknown }).texture;
  if (!maybeTexture || maybeTexture === Texture.EMPTY) return null;
  return isSizeLike(maybeTexture) ? maybeTexture : null;
}

function applyLivePreviewOverrides<T extends TimelineClip["transformations"][number]>(
  transform: T,
): T {
  let nextParameters: Record<string, unknown> | null = null;

  for (const paramName of Object.keys(transform.parameters)) {
    const previewValue = livePreviewParamStore.get(transform.id, paramName);
    if (previewValue === undefined) {
      continue;
    }

    if (!nextParameters) {
      nextParameters = { ...transform.parameters };
    }
    nextParameters[paramName] = previewValue;
  }

  if (!nextParameters) {
    return transform;
  }

  return {
    ...transform,
    parameters: nextParameters,
  };
}

export function applyClipTransforms(
  target: ClipTransformTarget,
  clip: TimelineClip,
  logicalContainerSize: { width: number; height: number },
  time?: number, // REFACTOR: Now expects TICKS
  contentSizeOverride?: { width: number; height: number },
  options?: ApplyClipTransformsOptions,
) {
  const targetTextureSize = getTargetTextureSize(target);
  if (
    !contentSizeOverride &&
    !targetTextureSize
  ) {
    return;
  }

  const texWidth = contentSizeOverride?.width ?? targetTextureSize?.width ?? 1;
  const texHeight = contentSizeOverride?.height ?? targetTextureSize?.height ?? 1;

  const baseLayoutMode = options?.baseLayoutMode ?? "contain";
  const layoutDefaults =
    baseLayoutMode === "origin"
      ? {
          scaleX: 1,
          scaleY: 1,
          x: 0,
          y: 0,
          rotation: 0,
        }
      : getBaseLayout(logicalContainerSize, {
          width: texWidth,
          height: texHeight,
        });

  const state: TransformState = {
    ...TransformationSystem.getDefaults(),
    ...layoutDefaults,
  } as TransformState;
  const shouldNotifyLiveParams = options?.notifyLiveParams !== false;

  if (clip.transformations && clip.transformations.length > 0) {
    // REFACTOR: Logic entirely in Ticks
    const defaultTime = time || 0;

    // 1. Source Offset (Ticks)
    // Simply add the crop duration. No conversion.
    const sourceTimeOffset = clip.transformedOffset || 0;

    // 2. Initialize Pulled Time (Ticks)
    let pulledTime = defaultTime + sourceTimeOffset;

    const effectiveTimes = new Array(clip.transformations.length).fill(
      pulledTime,
    );

    // --- Pass 1: Backward Time Propagation (Ticks) ---
    for (let i = clip.transformations.length - 1; i >= 0; i--) {
      const transform = clip.transformations[i];

      // Store Ticks
      effectiveTimes[i] = pulledTime;

      if (transform.isEnabled && transform.type === "speed") {
        const params = (
          transform as unknown as import("./types").SpeedTransform
        ).parameters;
        // getIdempotentTimeMap now handles Ticks -> Ticks natively
        pulledTime = getIdempotentTimeMap(params.factor, pulledTime);
      }
    }

    if (shouldNotifyLiveParams) {
      // Notify speed-transform parameters for live UI display.
      // `effectiveTimes[i]` for speed is output (visual) time. Speed splines are
      // keyed on speed-layer input time, so we map output->input before sampling.
      for (let i = 0; i < clip.transformations.length; i++) {
        const transform = clip.transformations[i];
        if (!transform.isEnabled || transform.type !== "speed") continue;

        const speedParams = (
          transform as unknown as import("./types").SpeedTransform
        ).parameters;
        const sampleTime = getIdempotentTimeMap(
          speedParams.factor,
          effectiveTimes[i],
        );

        for (const [paramName, param] of Object.entries(transform.parameters)) {
          liveParamStore.notify(
            transform.id,
            paramName,
            resolveScalar(param as ScalarParameter, sampleTime, 1),
          );
        }
      }
    }

    // --- Pass 2: Forward Application ---
    clip.transformations.forEach((transform, index) => {
      if (!transform.isEnabled) return;
      if (transform.type === "speed") return;
      const effectiveTransform = applyLivePreviewOverrides(transform);

      // CRITICAL: The Boundary Layer
      // We pass SECONDS to the visual applicator, because shaders/math
      // (e.g. Math.sin(t)) usually expect physical time, not 48,000 ticks.
      dispatchTransform(state, effectiveTransform, {
        container: logicalContainerSize,
        content: { width: texWidth, height: texHeight },
        time: effectiveTimes[index],
      });

      if (shouldNotifyLiveParams) {
        // Publish resolved parameter values for live UI display.
        // liveParamStore.notify is a no-op when no UI subscribers are active,
        // so this loop has negligible cost when the panel is closed.
        for (const [paramName, param] of Object.entries(
          effectiveTransform.parameters,
        )) {
          liveParamStore.notify(
            effectiveTransform.id,
            paramName,
            resolveScalar(param as ScalarParameter, effectiveTimes[index], 0),
          );
        }
      }
    });
  }

  TransformationSystem.applicators.forEach((apply) => apply(target, state));
}
