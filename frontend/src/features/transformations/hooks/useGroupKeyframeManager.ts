import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutGroup, ControlDefinition } from "../../panelUI/types";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { useTimelineStore, useTimelineClip } from "../../timeline";
import { playbackClock } from "../../player/services/PlaybackClock";
import {
  calculateClipTime,
  getTransformInputTimeAtVisualOffset,
} from "../utils/timeCalculation";
import { resolveScalar } from "../utils/resolveScalar";
import { isSplineParameter, type SplineParameter } from "../types";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import {
  upsertSplinePoint,
  collapseConstantSpline,
  removeSplinePoint,
} from "../utils/splineKeyframeUtils";
import { insertTransformRespectingDefaultOrder } from "./controller/transformOrdering";

const POINT_EPSILON_TICKS = 1;

interface UseGroupKeyframeManagerInput {
  group: LayoutGroup;
  transform?: ClipTransform;
  clipId?: string;
  timelineClip?: TimelineClip;
  targetTransforms?: ClipTransform[];
  onUpdateTransform?: (
    transformId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  onToggleKeyframe?: () => void;
}

interface UseGroupKeyframeManagerResult {
  enabled: boolean;
  active: boolean;
  toggleKeyframe: () => void;
  isPrimed: boolean;
}

function toModelValue(control: ControlDefinition, value: unknown): number {
  if (control.valueTransform?.toModel) {
    return control.valueTransform.toModel(value) as number;
  }
  return value as number;
}

function getSplineableControls(group: LayoutGroup): ControlDefinition[] {
  return group.controls.filter(
    (c) =>
      c.supportsSpline === true &&
      (c.type === "number" || c.type === "slider"),
  );
}

export function useGroupKeyframeManager({
  group,
  transform,
  clipId,
  timelineClip,
  targetTransforms,
  onUpdateTransform,
  onSetTransforms,
  onToggleKeyframe,
}: UseGroupKeyframeManagerInput): UseGroupKeyframeManagerResult {
  const storeClip = useTimelineClip(clipId);
  const clip = timelineClip ?? storeClip;
  const setClipTransforms = useTimelineStore((state) => state.setClipTransforms);
  const updateClipTransform = useTimelineStore((state) => state.updateClipTransform);
  const setActiveSpline = useTransformationViewStore((state) => state.setActiveSpline);
  const splineableControls = useMemo(() => getSplineableControls(group), [group]);
  const enabled = splineableControls.length > 0 && !!clip;
  const targetContextId = clipId ?? clip?.id;

  // Refs for values that the clock subscription needs without recreating the effect.
  const clipRef = useRef(clip);
  const transformRef = useRef(transform);

  useEffect(() => {
    clipRef.current = clip;
    transformRef.current = transform;
  }, [clip, transform]);

  // The resolved keyframe-time at the current playhead, stored in a ref so that
  // toggleKeyframe can read it without being in the reactive render path.
  const keyframeTimeRef = useRef<number | null>(null);

  // Track whether `active` changed so we only call setActive when necessary.
  const activeValueRef = useRef(false);
  const [active, setActive] = useState(false);

  const keyframeTimesSignature = useMemo(
    () => (transform?.keyframeTimes ?? []).join(","),
    [transform?.keyframeTimes],
  );

  useEffect(() => {
    if (!enabled) {
      keyframeTimeRef.current = null;
      if (activeValueRef.current) {
        activeValueRef.current = false;
      }
      return;
    }

    const update = (ticks: number) => {
      const currentClip = clipRef.current;
      const currentTransform = transformRef.current;
      if (!currentClip) return;

      const clipStart = currentClip.start;
      const clipEnd = currentClip.start + currentClip.timelineDuration;
      const clampedTime = Math.min(Math.max(ticks, clipStart), clipEnd);
      const localVisualTime = clampedTime - clipStart;

      const keyframeTime = currentTransform?.id
        ? getTransformInputTimeAtVisualOffset(
            currentClip,
            currentTransform.id,
            localVisualTime,
          )
        : calculateClipTime(currentClip, localVisualTime, true);

      keyframeTimeRef.current = keyframeTime;

      const nextActive = (currentTransform?.keyframeTimes ?? []).some(
        (time) => Math.abs(time - keyframeTime) <= POINT_EPSILON_TICKS,
      );

      if (nextActive !== activeValueRef.current) {
        activeValueRef.current = nextActive;
        setActive(nextActive);
      }
    };

    update(playbackClock.time);
    return playbackClock.subscribe(update);
  }, [enabled, transform?.id, keyframeTimesSignature]);

  const isPrimed = useMemo(
    () => (transform?.keyframeTimes?.length ?? 0) > 0,
    [transform],
  );

  const toggleKeyframe = useCallback(() => {
    const keyframeTime = keyframeTimeRef.current;
    const isActive = activeValueRef.current;
    const currentClip = clipRef.current;
    const currentTransform = transformRef.current;

    if (!currentClip || keyframeTime === null || splineableControls.length === 0) {
      return;
    }
    onToggleKeyframe?.();

    if (currentTransform) {
      const nextParams: Record<string, unknown> = { ...currentTransform.parameters };

      if (isActive) {
        const newKeyframeTimes = (currentTransform.keyframeTimes ?? []).filter(
          (time) => Math.abs(time - keyframeTime) > POINT_EPSILON_TICKS,
        );

        if (newKeyframeTimes.length === 0) {
          splineableControls.forEach((control) => {
            nextParams[control.name] = toModelValue(
              control,
              control.defaultValue ?? 0,
            );
          });
        } else {
          splineableControls.forEach((control) => {
            if (!isSplineParameter(nextParams[control.name])) return;
            nextParams[control.name] = collapseConstantSpline(
              removeSplinePoint(
                nextParams[control.name],
                keyframeTime,
                POINT_EPSILON_TICKS,
              ),
            );
          });
        }

        if (onUpdateTransform) {
          onUpdateTransform(currentTransform.id, {
            parameters: nextParams,
            keyframeTimes: newKeyframeTimes,
          });
        } else {
          updateClipTransform(currentClip.id, currentTransform.id, {
            parameters: nextParams,
            keyframeTimes: newKeyframeTimes,
          });
        }
      } else {
        const newKeyframeTimes = [...(currentTransform.keyframeTimes ?? [])];
        if (
          !newKeyframeTimes.some(
            (time) => Math.abs(time - keyframeTime) <= POINT_EPSILON_TICKS,
          )
        ) {
          newKeyframeTimes.push(keyframeTime);
          newKeyframeTimes.sort((a, b) => a - b);
        }

        splineableControls.forEach((control) => {
          const param = nextParams[control.name];
          if (!isSplineParameter(param)) return;
          const pointValue = resolveScalar(
            param as SplineParameter,
            keyframeTime,
            toModelValue(control, control.defaultValue ?? 0),
          );
          nextParams[control.name] = collapseConstantSpline(
            upsertSplinePoint(
              param,
              keyframeTime,
              pointValue,
              POINT_EPSILON_TICKS,
            ),
          );
        });

        if (onUpdateTransform) {
          onUpdateTransform(currentTransform.id, {
            parameters: nextParams,
            keyframeTimes: newKeyframeTimes,
          });
        } else {
          updateClipTransform(currentClip.id, currentTransform.id, {
            parameters: nextParams,
            keyframeTimes: newKeyframeTimes,
          });
        }

        const activeControl = splineableControls.find((control) =>
          isSplineParameter(nextParams[control.name]),
        );
        if (activeControl && targetContextId) {
          setActiveSpline({
            clipId: targetContextId,
            transformId: currentTransform.id,
            property: activeControl.name,
          });
        }
      }

      return;
    }

    const params: Record<string, unknown> = {};
    group.controls.forEach((control) => {
      if (control.type === "spacer") return;
      params[control.name] = control.valueTransform?.toModel
        ? control.valueTransform.toModel(control.defaultValue ?? 0)
        : (control.defaultValue ?? 0);
    });

    const newTransform: ClipTransform = {
      id: crypto.randomUUID(),
      type: group.id,
      isEnabled: true,
      parameters: params,
      keyframeTimes: [keyframeTime],
    };

    const transformsForInsertion = targetTransforms ?? currentClip.transformations ?? [];
    const nextTransforms = insertTransformRespectingDefaultOrder(
      transformsForInsertion,
      newTransform,
    );

    if (onSetTransforms) {
      onSetTransforms(nextTransforms);
    } else {
      setClipTransforms(currentClip.id, nextTransforms);
    }

    if (targetContextId) {
      setActiveSpline({
        clipId: targetContextId,
        transformId: newTransform.id,
        property: splineableControls[0]?.name ?? "",
      });
    }
  }, [
    splineableControls,
    group,
    updateClipTransform,
    setClipTransforms,
    setActiveSpline,
    onToggleKeyframe,
    onUpdateTransform,
    onSetTransforms,
    targetTransforms,
    targetContextId,
  ]);

  return {
    enabled,
    active: enabled && active,
    toggleKeyframe,
    isPrimed,
  };
}
