import {
  TransformationSystem,
  dispatchTransform,
} from "./catalogue/TransformationRegistry";
import { getBaseLayout } from "./catalogue/layout/layoutDefinition";
import { Texture } from "pixi.js";
import type { ClipTransform } from "../../types/TimelineTypes";
import type {
  ClipTransformTarget,
  TransformState,
} from "./catalogue/types";
import type { TimelineClip } from "../../types/TimelineTypes";
import { getIdempotentTimeMap } from "./utils/timeCalculation";
import { resolveScalar } from "./utils/resolveScalar";
import type { ScalarParameter } from "./types";
import { liveParamStore } from "../../core/liveParams/liveParamStore";
import { livePreviewParamStore } from "../../core/liveParams/livePreviewParamStore";

export type FitMode = "contain" | "cover";

export interface ApplyClipTransformsOptions {
  baseLayoutMode?: FitMode | "origin";
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

function applyLivePreviewOverrides<T extends ClipTransform>(transform: T): T {
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

// ============================================================================
// applyTransformStack — shared transform-stack dispatch
// ============================================================================

export interface ApplyTransformStackContext {
  /** Project / output container size used by transforms that depend on
   *  container dimensions (e.g. layout's contain/cover math). */
  container: { width: number; height: number };
  /** Renderable content size — clip texture for clips, project size for
   *  group containers. Passed into transform dispatch and forwarded to the
   *  filter applicator so spatial filter parameters scale correctly on
   *  textureless targets (Pixi Containers). */
  content: { width: number; height: number };
  /** Visible / output time at which this dispatch is happening, *before* any
   *  source-time remapping from the backward speed pass. Forwarded into each
   *  handler's `TransformContext.visualTime` for effects that need
   *  output-domain math (e.g. visual-duration ratios, output-time-driven
   *  animation). Per-transform keyframe sampling does NOT read this — it
   *  reads `effectiveTimes[index]`, derived from the `time` argument and the
   *  backward speed pass. Falls back to `time` when omitted.
   *
   *  Clip callers pass the raw input tick (pre-`transformedOffset`); group
   *  callers pass the clip-local tick. */
  visualTime?: number;
  /** Visible duration of the target, forwarded as `TransformContext.
   *  visualDuration`. Used by handlers whose output depends on the target's
   *  visual length (e.g. progress-bar animations). */
  visualDuration?: number;
}

export interface ApplyTransformStackOptions {
  baseLayoutMode?: FitMode | "origin";
  notifyLiveParams?: boolean;
}

/**
 * Run the shared transform stack: backward speed-pass to derive per-transform
 * effective times, then forward dispatch through `dispatchTransform`.
 *
 * Returns the resolved `TransformState` and the post-speed `sourceTimeTicks`.
 * The caller is responsible for running applicators (via `runApplicators`)
 * once it has finished pushing any clip- or group-specific extras into
 * `state.filters` (e.g. range-mask alpha ops).
 *
 * Used by `applyClipTransforms` (clip-side wrapper that resolves fitMode and
 * pushes range-mask filter ops before applicators run) and
 * `applyGroupTransforms` (group-side wrapper that passes
 * `baseLayoutMode: "origin"` and content = logical project size).
 */
export function applyTransformStack(
  transformations: readonly ClipTransform[] | undefined,
  ctx: ApplyTransformStackContext,
  time?: number,
  options: ApplyTransformStackOptions = {},
): { state: TransformState; sourceTimeTicks: number } {
  const baseLayoutMode = options.baseLayoutMode ?? "contain";
  const layoutDefaults =
    baseLayoutMode === "origin"
      ? {
          scaleX: 1,
          scaleY: 1,
          x: 0,
          y: 0,
          rotation: 0,
        }
      : getBaseLayout(ctx.container, ctx.content, baseLayoutMode);

  const state: TransformState = {
    ...TransformationSystem.getDefaults(),
    ...layoutDefaults,
  } as TransformState;
  const shouldNotifyLiveParams = options.notifyLiveParams !== false;

  const defaultTime = time || 0;
  let sourceTimeTicks = defaultTime;

  if (transformations && transformations.length > 0) {
    let pulledTime = sourceTimeTicks;
    const effectiveTimes = new Array(transformations.length).fill(pulledTime);

    // Pass 1: Backward time propagation through speed transforms.
    for (let i = transformations.length - 1; i >= 0; i--) {
      const transform = transformations[i];
      effectiveTimes[i] = pulledTime;
      if (transform.isEnabled && transform.type === "speed") {
        const params = (
          transform as unknown as import("./types").SpeedTransform
        ).parameters;
        pulledTime = getIdempotentTimeMap(params.factor, pulledTime);
      }
    }
    sourceTimeTicks = pulledTime;

    if (shouldNotifyLiveParams) {
      // Speed-transform live param notifications use post-speed (input) time.
      for (let i = 0; i < transformations.length; i++) {
        const transform = transformations[i];
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

    // Pass 2: Forward dispatch of non-speed transforms.
    //
    // Source-time anchoring: every value transform samples its keyframes at the
    // fully-resolved `sourceTimeTicks` (source-media time in project ticks, after
    // pulling the visual tick back through the *entire* speed stack), NOT at its
    // per-index effective time. This makes a transform's output a property of
    // the displayed source content, so speed only reschedules *when* that
    // content appears, never *what* its values are — and the result is
    // independent of where speed sits in the stack.
    // For the common layout-before-speed case `effectiveTimes[layoutIndex]`
    // already equals `sourceTimeTicks`, so this is a no-op there. Keyframe times
    // are stored to match via `clipVisualToSourceTime` (see clipTimeDomains).
    transformations.forEach((transform) => {
      if (!transform.isEnabled) return;
      if (transform.type === "speed") return;
      const effectiveTransform = applyLivePreviewOverrides(transform);

      dispatchTransform(state, effectiveTransform, {
        container: ctx.container,
        content: ctx.content,
        time: sourceTimeTicks,
        visualTime: ctx.visualTime ?? defaultTime,
        visualDuration: ctx.visualDuration,
      });

      if (shouldNotifyLiveParams) {
        for (const [paramName, param] of Object.entries(
          effectiveTransform.parameters,
        )) {
          liveParamStore.notify(
            effectiveTransform.id,
            paramName,
            resolveScalar(param as ScalarParameter, sourceTimeTicks, 0),
          );
        }
      }
    });
  }

  return { state, sourceTimeTicks };
}

/**
 * Run every registered state applicator (layout, filter, ...) against the
 * resolved transform state. Separated from `applyTransformStack` so the
 * clip-side wrapper can push range-mask filter ops into `state.filters`
 * before the applicators run.
 */
export function runApplicators(
  target: ClipTransformTarget,
  state: TransformState,
  contentSize: { width: number; height: number },
): void {
  TransformationSystem.applicators.forEach((apply) =>
    apply(target, state, contentSize),
  );
}

// ============================================================================
// applyClipTransforms — clip-side wrapper
// ============================================================================

export function applyClipTransforms(
  target: ClipTransformTarget,
  clip: TimelineClip,
  logicalContainerSize: { width: number; height: number },
  time?: number, // REFACTOR: Now expects TICKS
  contentSizeOverride?: { width: number; height: number },
  options?: ApplyClipTransformsOptions,
) {
  const targetTextureSize = getTargetTextureSize(target);
  if (!contentSizeOverride && !targetTextureSize) {
    return;
  }

  const texWidth = contentSizeOverride?.width ?? targetTextureSize?.width ?? 1;
  const texHeight = contentSizeOverride?.height ?? targetTextureSize?.height ?? 1;
  const contentSize = { width: texWidth, height: texHeight };

  // Per-clip fitMode override (from a "fitMode" transform entry) takes priority
  // over the caller's baseLayoutMode option.
  const clipFitTransform = clip.transformations?.find(
    (t) => t.type === "fitMode" && t.isEnabled,
  );
  const clipFitMode =
    clipFitTransform?.parameters?.fitMode === "contain" ||
    clipFitTransform?.parameters?.fitMode === "cover"
      ? (clipFitTransform.parameters.fitMode as FitMode)
      : undefined;

  const baseLayoutMode = clipFitMode ?? options?.baseLayoutMode ?? "contain";
  const sourceTimeOffset = clip.transformedOffset || 0;
  const stackTime = (time ?? 0) + sourceTimeOffset;

  const { state, sourceTimeTicks } = applyTransformStack(
    clip.transformations,
    {
      container: logicalContainerSize,
      content: contentSize,
      visualTime: time ?? 0,
      visualDuration: clip.timelineDuration,
    },
    stackTime,
    {
      baseLayoutMode,
      notifyLiveParams: options?.notifyLiveParams,
    },
  );

  // Range-mask components: evaluate at clip source time (post-speed).
  // If any active range covers the current source-media time, push a single
  // alpha=0 filter op — the filter applicator will turn it into a PixiJS
  // AlphaFilter.
  if (clip.type !== "mask" && clip.components?.length) {
    for (const component of clip.components) {
      if (component.type !== "range_mask") continue;
      const { isActive, startSourceTicks, endSourceTicks } = component.parameters;
      if (!isActive) continue;
      if (
        sourceTimeTicks >= startSourceTicks &&
        sourceTimeTicks <= endSourceTicks
      ) {
        state.filters.push({
          type: "AlphaFilter",
          params: { alpha: 0 },
        });
        break;
      }
    }
  }

  runApplicators(target, state, contentSize);
}
