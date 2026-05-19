import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import type {
  PositionPathParameter,
  PositionParams,
  ScalarParameter,
  SpeedTransform,
} from "../types";
import { isSplineParameter } from "../types";
import {
  reflectKeyframeTimes,
  reflectScalarParameterTime,
  reversePositionPath,
} from "./reverseSpline";
import { pushTimeThroughTransforms } from "./timeCalculation";

/**
 * Stack-aware reversal of a `ClipTransform[]`.
 *
 * Each transform layer's parameter splines live in a time domain equal to
 * that layer's INPUT-time (i.e. source time pushed forward through every
 * upstream transform). For the reversal recipe see [reverseSpline](./reverseSpline.ts):
 *
 *   • For a scalar parameter spline, the mirror point M_i is the midpoint of
 *     the layer-i input domain that spans the FULL source range [0, S]:
 *
 *         M_i = pushTimeThroughTransforms(upstreamLayers, S) / 2
 *
 *     This center coincides for pre- and post-reversal stacks because
 *     reversing speed splines preserves their total integrated duration.
 *
 *   • For `PositionParams.path`, the timing spline is mirrored across (0.5,
 *     0.5) in normalized space; the 2D control points are preserved.
 *
 *   • Speed splines use the same mirror-point formula as scalars (their input
 *     is also a layer-input time).
 *
 * The caller is responsible for swapping the underlying asset (so source
 * frames play in reverse) and updating clip trim/offset metadata to match.
 */

function getLayerMirrorTime(
  transforms: readonly ClipTransform[],
  index: number,
  sourceDurationTicks: number,
): number {
  const upstream = transforms.slice(0, index);
  // Push the full asset duration forward through upstream layers. Pre-reversal
  // splines/speeds are used; that's fine because reversing speed preserves the
  // pushed duration.
  const pushed = pushTimeThroughTransforms(
    [...upstream] as ClipTransform[],
    sourceDurationTicks,
  );
  return pushed / 2;
}

function reverseScalarParamMap(
  params: Record<string, unknown>,
  mirrorTime: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "path") {
      // Handled by reversePositionParams.
      next[key] = value;
      continue;
    }
    if (typeof value === "number" || isSplineParameter(value)) {
      next[key] = reflectScalarParameterTime(
        value as ScalarParameter,
        mirrorTime,
      );
    } else {
      next[key] = value;
    }
  }
  return next;
}

function reversePositionParams(
  params: PositionParams,
  mirrorTime: number,
): PositionParams {
  const next: PositionParams = {
    ...params,
    x: reflectScalarParameterTime(params.x, mirrorTime) as PositionParams["x"],
    y: reflectScalarParameterTime(params.y, mirrorTime) as PositionParams["y"],
  };
  if (params.path) {
    next.path = reversePositionPath(params.path as PositionPathParameter);
  }
  return next;
}

/**
 * Produce a new `ClipTransform[]` whose every spline / keyframe-time has been
 * reflected so the visual experience plays in reverse, assuming the
 * underlying source has been reversed alongside.
 */
export function reverseTransformationStack(
  transforms: readonly ClipTransform[],
  sourceDurationTicks: number,
): ClipTransform[] {
  if (transforms.length === 0) return [];

  return transforms.map((transform, index) => {
    const mirrorTime = getLayerMirrorTime(
      transforms,
      index,
      sourceDurationTicks,
    );

    let nextParameters: Record<string, unknown>;
    if (transform.type === "position") {
      nextParameters = reversePositionParams(
        transform.parameters as PositionParams,
        mirrorTime,
      );
    } else if (transform.type === "speed") {
      const speedParams = (transform as SpeedTransform).parameters;
      nextParameters = {
        ...speedParams,
        factor: reflectScalarParameterTime(speedParams.factor, mirrorTime),
      };
    } else {
      nextParameters = reverseScalarParamMap(
        transform.parameters,
        mirrorTime,
      );
    }

    return {
      ...transform,
      parameters: nextParameters,
      keyframeTimes: reflectKeyframeTimes(transform.keyframeTimes, mirrorTime),
    };
  });
}

/**
 * Convenience: invoke `reverseTransformationStack` against a clip's
 * transformations, using the clip's `sourceDuration`. Returns the stack to
 * apply post-reversal. Throws if the clip has no finite source duration
 * (e.g. still images), since reversal needs an explicit time horizon.
 */
export function reverseClipTransformationStack(
  clip: Pick<TimelineClip, "transformations" | "sourceDuration">,
): ClipTransform[] {
  const sourceDuration = clip.sourceDuration;
  if (!sourceDuration || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error(
      "Cannot reverse transformations without a finite source duration.",
    );
  }
  return reverseTransformationStack(clip.transformations ?? [], sourceDuration);
}
