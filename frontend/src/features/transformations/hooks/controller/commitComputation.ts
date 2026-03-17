import type {
  ClipTransform,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { AnyTransform, SplineParameter } from "../../types";
import { isSplineParameter } from "../../types";
import {
  getEntryForTransform,
  getEntryByType,
} from "../../catalogue/TransformationRegistry";
import type { LayoutGroup } from "../../catalogue/ui/UITypes";
import { calculateLinkedParameter } from "../../utils/aspectRatio";
import { getTransformInputTimeAtVisualOffset } from "../../utils/timeCalculation";
import { resolveScalar } from "../../utils/resolveScalar";
import {
  upsertSplinePoint,
  collapseConstantSpline,
  materializeFromScalar,
  diffSplinePointTimes,
  hasExplicitSplinePointAtTime,
} from "../../utils/splineKeyframeUtils";
import { createCommittedTransform } from "./transformFactory";

function areTimeArraysEqual(
  left: number[] | undefined,
  right: number[],
  epsilon: number,
): boolean {
  const leftSafe = left ?? [];
  if (leftSafe.length !== right.length) return false;
  return leftSafe.every((time, index) => Math.abs(time - right[index]) <= epsilon);
}

export interface CommitComputationInput {
  groupId: string;
  controlName: string;
  value: unknown;
  transformId?: string;
  transforms: ClipTransform[];
  activeClip?: TimelineClip;
  playheadTicks: number;
  pointEpsilonTicks: number;
}

interface CommitComputationBase {
  mode: "update" | "create";
  existingTransform?: ClipTransform;
  parameters: Record<string, unknown>;
  keyframeTimes?: number[];
  groupId: string;
  controlName: string;
}

export interface CommitUpdateComputation extends CommitComputationBase {
  mode: "update";
  existingTransform: ClipTransform;
}

export interface CommitCreateComputation extends CommitComputationBase {
  mode: "create";
  createdTransform: AnyTransform;
}

export type CommitComputationResult =
  | CommitUpdateComputation
  | CommitCreateComputation;

export function computeCommitMutation({
  groupId,
  controlName,
  value,
  transformId,
  transforms,
  activeClip,
  playheadTicks,
  pointEpsilonTicks,
}: CommitComputationInput): CommitComputationResult {
  // 1. Resolve configuration
  let groupConfig: LayoutGroup | undefined;
  const existingTransform = transformId
    ? transforms.find((transform) => transform.id === transformId)
    : transforms.find((transform) => transform.type === groupId);

  if (existingTransform) {
    const entry = getEntryForTransform(existingTransform);
    if (entry) {
      groupConfig =
        entry.uiConfig.groups.find((group) => group.id === groupId) ||
        entry.uiConfig.groups[0];
    }
  } else {
    const entry = getEntryByType(groupId);
    groupConfig = entry?.uiConfig.groups.find((group) => group.id === groupId);
  }

  // 2. Prepare parameters
  let finalParams: Record<string, unknown> = {};

  if (existingTransform) {
    finalParams = { ...existingTransform.parameters };
  } else if (groupConfig) {
    groupConfig.controls.forEach((control) => {
      finalParams[control.name] = control.defaultValue;
    });
  }

  // 3. Process value
  let finalValue = value;
  const controlDef = groupConfig?.controls.find(
    (control) => control.name === controlName,
  );

  if (controlDef?.valueTransform?.toModel) {
    if (isSplineParameter(value)) {
      const splineValue = value as SplineParameter;
      finalValue = {
        ...splineValue,
        points: splineValue.points.map((point) => ({
          ...point,
          value: controlDef.valueTransform!.toModel(point.value),
        })),
      };
    } else {
      finalValue = controlDef.valueTransform.toModel(value as number);
    }
  }

  // Link logic
  if (finalParams["isLinked"] === true) {
    const numberControls =
      groupConfig?.controls.filter((control) => control.type === "number") || [];
    const otherControl = numberControls.find((control) => control.name !== controlName);
    if (otherControl) {
      const currentParam = (finalParams[controlName] ??
        controlDef?.defaultValue ??
        0) as number | SplineParameter;
      const otherParam = (finalParams[otherControl.name] ??
        otherControl.defaultValue ??
        0) as number | SplineParameter;
      const newOther = calculateLinkedParameter(
        currentParam,
        otherParam,
        finalValue as number | SplineParameter,
      );
      if (newOther !== null) {
        finalParams[otherControl.name] = newOther;
      }
    }
  }

  // 4. Group-wide spline sync
  let didGroupSync = false;
  let newKeyframeTimes: number[] | undefined;

  if (
    typeof finalValue === "number" &&
    controlDef?.supportsSpline &&
    existingTransform &&
    groupConfig
  ) {
    const currentKeyframeTimes = existingTransform.keyframeTimes ?? [];
    const isControlSplineInPlace = isSplineParameter(
      existingTransform.parameters[controlName],
    );
    const shouldSyncGroup =
      currentKeyframeTimes.length > 0 || isControlSplineInPlace;

    if (shouldSyncGroup && activeClip) {
      const clipStart = activeClip.start;
      const clampedGlobal = Math.max(
        clipStart,
        Math.min(playheadTicks, activeClip.start + activeClip.timelineDuration),
      );
      const localVisual = clampedGlobal - clipStart;
      const keyframeTime = getTransformInputTimeAtVisualOffset(
        activeClip,
        existingTransform.id,
        localVisual,
      );

      newKeyframeTimes = [...currentKeyframeTimes];
      if (
        !newKeyframeTimes.some(
          (time) => Math.abs(time - keyframeTime) <= pointEpsilonTicks,
        )
      ) {
        newKeyframeTimes.push(keyframeTime);
        newKeyframeTimes.sort((left, right) => left - right);
      }

      const splineableControls = groupConfig.controls.filter(
        (control) =>
          control.supportsSpline &&
          (control.type === "number" || control.type === "slider"),
      );

      splineableControls.forEach((control) => {
        const currentParam = existingTransform.parameters[control.name];
        const committedParam = finalParams[control.name];

        if (control.name === controlName) {
          if (!isSplineParameter(currentParam)) {
            const scalarVal =
              typeof currentParam === "number"
                ? currentParam
                : ((control.defaultValue as number) ?? 0);
            if (Math.abs((finalValue as number) - scalarVal) > 1e-9) {
              finalParams[control.name] = materializeFromScalar(
                scalarVal,
                newKeyframeTimes!,
                keyframeTime,
                finalValue as number,
                pointEpsilonTicks,
              );
            }
          } else {
            finalParams[control.name] = collapseConstantSpline(
              upsertSplinePoint(
                currentParam,
                keyframeTime,
                finalValue as number,
                pointEpsilonTicks,
              ),
            );
          }
        } else {
          // Linked controls (e.g. scale.x <-> scale.y) may have an explicit committed
          // scalar value at the current keyframe time. Preserve that as a keyframed edit
          // instead of flattening the entire control to a new scalar.
          const committedScalar =
            typeof committedParam === "number" ? committedParam : null;

          if (isSplineParameter(currentParam)) {
            const pointValue =
              committedScalar ??
              resolveScalar(
                currentParam,
                keyframeTime,
                (control.defaultValue as number) ?? 0,
              );
            finalParams[control.name] = collapseConstantSpline(
              upsertSplinePoint(
                currentParam,
                keyframeTime,
                pointValue,
                pointEpsilonTicks,
              ),
            );
          } else if (committedScalar !== null) {
            const scalarVal =
              typeof currentParam === "number"
                ? currentParam
                : ((control.defaultValue as number) ?? 0);
            if (Math.abs(committedScalar - scalarVal) > 1e-9) {
              finalParams[control.name] = materializeFromScalar(
                scalarVal,
                newKeyframeTimes!,
                keyframeTime,
                committedScalar,
                pointEpsilonTicks,
              );
            }
          }
        }
      });

      didGroupSync = true;
    }
  }

  if (
    !didGroupSync &&
    existingTransform &&
    groupConfig &&
    controlDef?.supportsSpline &&
    isSplineParameter(finalValue)
  ) {
    const previousParam = existingTransform.parameters[controlName];
    const previousPoints = isSplineParameter(previousParam)
      ? previousParam.points
      : [];
    const splineDiff = diffSplinePointTimes(
      previousPoints,
      finalValue.points,
      pointEpsilonTicks,
    );

    const updatedKeyframeTimes = [...(existingTransform.keyframeTimes ?? [])];
    const paramsAfterCommit: Record<string, unknown> = {
      ...existingTransform.parameters,
      ...finalParams,
      [controlName]: finalValue,
    };
    const splineableControls = groupConfig.controls.filter(
      (control) =>
        control.supportsSpline &&
        (control.type === "number" || control.type === "slider"),
    );

    const timesToAdd = [...splineDiff.addedTimes];
    if (finalValue.points.length > 0) {
      let minTime = finalValue.points[0].time;
      let maxTime = finalValue.points[0].time;
      finalValue.points.forEach((point) => {
        if (point.time < minTime) minTime = point.time;
        if (point.time > maxTime) maxTime = point.time;
      });
      timesToAdd.push(minTime);
      if (Math.abs(maxTime - minTime) > pointEpsilonTicks) {
        timesToAdd.push(maxTime);
      }
    }

    timesToAdd.forEach((addedTime) => {
      if (
        !updatedKeyframeTimes.some(
          (time) => Math.abs(time - addedTime) <= pointEpsilonTicks,
        )
      ) {
        updatedKeyframeTimes.push(addedTime);
      }
    });

    splineDiff.removedTimes.forEach((removedTime) => {
      const referencedByOtherSpline = splineableControls.some((control) => {
        if (control.name === controlName) return false;
        return hasExplicitSplinePointAtTime(
          paramsAfterCommit[control.name],
          removedTime,
          pointEpsilonTicks,
        );
      });

      if (!referencedByOtherSpline) {
        for (let i = updatedKeyframeTimes.length - 1; i >= 0; i -= 1) {
          if (Math.abs(updatedKeyframeTimes[i] - removedTime) <= pointEpsilonTicks) {
            updatedKeyframeTimes.splice(i, 1);
          }
        }
      }
    });

    updatedKeyframeTimes.sort((left, right) => left - right);
    if (
      !areTimeArraysEqual(
        existingTransform.keyframeTimes,
        updatedKeyframeTimes,
        pointEpsilonTicks,
      )
    ) {
      newKeyframeTimes = updatedKeyframeTimes;
    }
  }

  if (!didGroupSync) {
    finalParams[controlName] = finalValue;
  }

  if (existingTransform) {
    return {
      mode: "update",
      existingTransform,
      parameters: finalParams,
      keyframeTimes: newKeyframeTimes,
      groupId,
      controlName,
    };
  }

  return {
    mode: "create",
    createdTransform: createCommittedTransform(groupId, finalParams),
    parameters: finalParams,
    groupId,
    controlName,
  };
}
