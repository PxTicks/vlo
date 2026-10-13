/**
 * layoutKeyframeGroup.ts
 *
 * Position, scale and rotation are stored as three transforms, each with its own
 * `keyframeTimes`, but they are edited as one layout keyframe track: a key at a
 * time exists in all three or in none. Storage is unchanged, so saved projects
 * load and render exactly as before; every editing path (panel commits, keyframe
 * toggles, canvas drags, timeline diamonds) routes through these helpers so the
 * three tracks stay aligned from the first edit at a time onwards.
 *
 * A transform with `keyframeTimes` but scalar parameters is "keyed and holding a
 * constant" — the same representation the commit pipeline already uses — so an
 * un-keyed channel joins the track just by adopting the track's times.
 */

import type { ClipTransform } from "../../../types/TimelineTypes";
import { isSplineParameter } from "../types";
import { resolveScalar } from "./resolveScalar";
import {
  collapseConstantSpline,
  removeSplinePoint,
  upsertSplinePoint,
} from "./splineKeyframeUtils";
import { createAddTransform } from "../hooks/controller/transformFactory";
import { insertTransformRespectingDefaultOrder } from "../hooks/controller/transformOrdering";

export const LAYOUT_KEYFRAME_GROUP_TYPES = ["position", "scale", "rotation"] as const;

const LAYOUT_TYPE_SET: ReadonlySet<string> = new Set(LAYOUT_KEYFRAME_GROUP_TYPES);

export function isLayoutKeyframeGroupType(type: string): boolean {
  return LAYOUT_TYPE_SET.has(type);
}

/** A position that follows a path keeps its timing inside the path, so it sits
 *  outside the shared track (section keyframes already skip it). */
function isPathDrivenPosition(transform: ClipTransform): boolean {
  if (transform.type !== "position") return false;
  const parameters = transform.parameters as Record<string, unknown>;
  return Boolean(parameters.path) || Boolean(parameters.extensionPath);
}

/** Whether a transform takes part in the shared layout keyframe track. */
export function isLayoutKeyframeTransform(transform: ClipTransform): boolean {
  return isLayoutKeyframeGroupType(transform.type) && !isPathDrivenPosition(transform);
}

function hasTime(times: readonly number[], time: number, epsilon: number): boolean {
  return times.some((candidate) => Math.abs(candidate - time) <= epsilon);
}

function isKeyed(transform: ClipTransform): boolean {
  return (
    (transform.keyframeTimes?.length ?? 0) > 0 ||
    Object.values(transform.parameters).some(isSplineParameter)
  );
}

/** Sorted union of every participating transform's keyframe times. */
export function getLayoutKeyframeTimes(
  transforms: readonly ClipTransform[],
  epsilon: number,
): number[] {
  const union: number[] = [];
  transforms.forEach((transform) => {
    if (!isLayoutKeyframeTransform(transform)) return;
    (transform.keyframeTimes ?? []).forEach((time) => {
      if (!hasTime(union, time, epsilon)) union.push(time);
    });
  });
  return union.sort((left, right) => left - right);
}

function mapLayoutTransforms(
  transforms: ClipTransform[],
  map: (transform: ClipTransform) => ClipTransform,
): ClipTransform[] {
  let changed = false;
  const next = transforms.map((transform) => {
    if (!isLayoutKeyframeTransform(transform)) return transform;
    const mapped = map(transform);
    if (mapped !== transform) changed = true;
    return mapped;
  });
  return changed ? next : transforms;
}

/**
 * Put a layout key at `time` into every participating transform, each holding
 * the value it currently shows there. An un-keyed channel adopts the whole
 * track so its constant is held at every other key too.
 */
export function addLayoutKeyframe(
  transforms: ClipTransform[],
  time: number,
  epsilon: number,
): ClipTransform[] {
  const trackTimes = getLayoutKeyframeTimes(transforms, epsilon);
  if (!hasTime(trackTimes, time, epsilon)) {
    trackTimes.push(time);
    trackTimes.sort((left, right) => left - right);
  }

  return mapLayoutTransforms(transforms, (transform) => {
    if (!isKeyed(transform)) {
      return { ...transform, keyframeTimes: [...trackTimes] };
    }

    const keyframeTimes = transform.keyframeTimes ?? [];
    const parameters: Record<string, unknown> = { ...transform.parameters };
    let parametersChanged = false;
    Object.entries(transform.parameters).forEach(([name, value]) => {
      if (!isSplineParameter(value)) return;
      if (value.points.some((point) => Math.abs(point.time - time) <= epsilon)) {
        return;
      }
      // 1. Hold the value currently shown at `time` so the edit doesn't
      //    move this channel there.
      parameters[name] = collapseConstantSpline(
        upsertSplinePoint(value, time, resolveScalar(value, time, 0), epsilon),
      );
      parametersChanged = true;
    });

    if (hasTime(keyframeTimes, time, epsilon) && !parametersChanged) {
      return transform;
    }
    return {
      ...transform,
      parameters,
      keyframeTimes: hasTime(keyframeTimes, time, epsilon)
        ? keyframeTimes
        : [...keyframeTimes, time].sort((left, right) => left - right),
    };
  });
}

/**
 * Remove the layout key at `time` from every participating transform. A channel
 * left without keys keeps the value it showed at `time` rather than snapping to
 * a default, so un-keying never moves the clip.
 */
export function removeLayoutKeyframe(
  transforms: ClipTransform[],
  time: number,
  epsilon: number,
): ClipTransform[] {
  return mapLayoutTransforms(transforms, (transform) => {
    const keyframeTimes = transform.keyframeTimes ?? [];
    if (!hasTime(keyframeTimes, time, epsilon)) return transform;

    const remainingTimes = keyframeTimes.filter(
      (candidate) => Math.abs(candidate - time) > epsilon,
    );
    const parameters: Record<string, unknown> = {};
    Object.entries(transform.parameters).forEach(([name, value]) => {
      if (!isSplineParameter(value)) {
        parameters[name] = value;
        return;
      }
      parameters[name] =
        remainingTimes.length === 0
          ? resolveScalar(value, time, 0)
          : collapseConstantSpline(removeSplinePoint(value, time, epsilon));
    });

    return { ...transform, parameters, keyframeTimes: remainingTimes };
  });
}

/** Move the layout key at `fromTime` to `toTime` in every transform that has it. */
export function moveLayoutKeyframe(
  transforms: ClipTransform[],
  fromTime: number,
  toTime: number,
  epsilon: number,
): ClipTransform[] {
  if (Math.abs(toTime - fromTime) <= epsilon) return transforms;
  const retime = (candidate: number) =>
    Math.abs(candidate - fromTime) <= epsilon ? toTime : candidate;

  return mapLayoutTransforms(transforms, (transform) => {
    const keyframeTimes = transform.keyframeTimes ?? [];
    if (!hasTime(keyframeTimes, fromTime, epsilon)) return transform;

    const parameters: Record<string, unknown> = {};
    Object.entries(transform.parameters).forEach(([name, value]) => {
      parameters[name] = isSplineParameter(value)
        ? {
            type: "spline" as const,
            points: value.points
              .map((point) => ({ ...point, time: retime(point.time) }))
              .sort((left, right) => left.time - right.time),
          }
        : value;
    });

    return {
      ...transform,
      parameters,
      keyframeTimes: keyframeTimes.map(retime).sort((left, right) => left - right),
    };
  });
}

/**
 * Prepare a layout commit on `groupId` while the track has keys: the target
 * transform must already be keyed (holding its current value at every track
 * time) so the commit adds one key at the playhead instead of changing the
 * channel at every frame. A missing target is created holding its defaults.
 */
export function prepareLayoutKeyframeCommit(
  transforms: ClipTransform[],
  groupId: string,
  transformId: string | undefined,
  epsilon: number,
): ClipTransform[] {
  if (!isLayoutKeyframeGroupType(groupId)) return transforms;
  const trackTimes = getLayoutKeyframeTimes(transforms, epsilon);
  if (trackTimes.length === 0) return transforms;

  const target = transformId
    ? transforms.find((transform) => transform.id === transformId)
    : transforms.find((transform) => transform.type === groupId);

  if (!target) {
    const created = createAddTransform(groupId);
    if (!created) return transforms;
    return insertTransformRespectingDefaultOrder(transforms, {
      ...(created as ClipTransform),
      keyframeTimes: trackTimes,
    });
  }

  if (!isLayoutKeyframeTransform(target) || isKeyed(target)) return transforms;
  return transforms.map((transform) =>
    transform === target ? { ...transform, keyframeTimes: trackTimes } : transform,
  );
}

/**
 * Finish a layout commit made at `time`: when the track has keys, every
 * participating transform gets a key there too.
 */
export function completeLayoutKeyframeCommit(
  transforms: ClipTransform[],
  groupId: string,
  time: number | null,
  epsilon: number,
): ClipTransform[] {
  if (time === null || !isLayoutKeyframeGroupType(groupId)) return transforms;
  // Editing a path-driven position's fields doesn't key the track.
  const committed = transforms.find((transform) => transform.type === groupId);
  if (!committed || !isLayoutKeyframeTransform(committed)) return transforms;
  if (getLayoutKeyframeTimes(transforms, epsilon).length === 0) return transforms;
  return addLayoutKeyframe(transforms, time, epsilon);
}
