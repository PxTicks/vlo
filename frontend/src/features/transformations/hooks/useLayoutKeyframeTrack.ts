import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import {
  setTimelineClipTransforms,
  useTimelineClip,
  getTimelinePresentationContext,
} from "../../timeline/api";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { clampedClipSourceTime } from "../../timeline/time";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { insertTransformRespectingDefaultOrder } from "./controller/transformOrdering";
import { createAddTransform } from "./controller/transformFactory";
import {
  LAYOUT_KEYFRAME_GROUP_TYPES,
  addLayoutKeyframe,
  getLayoutKeyframeTimes,
  isLayoutKeyframeTransform,
  removeLayoutKeyframe,
} from "../utils/layoutKeyframeGroup";

const POINT_EPSILON_TICKS = 1;

/** Control the curve editor opens on after keying each layout transform. */
const FIRST_LAYOUT_CONTROL: Record<string, string> = {
  position: "x",
  scale: "x",
  rotation: "angle",
};

interface UseLayoutKeyframeTrackInput {
  clipId?: string;
  timelineClip?: TimelineClip;
  targetTransforms?: ClipTransform[];
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  onToggleKeyframe?: () => void;
}

interface UseLayoutKeyframeTrackResult {
  enabled: boolean;
  active: boolean;
  toggleKeyframe: () => void;
}

/**
 * The single keyframe toggle for the layout group: position, scale and
 * rotation share one track (see layoutKeyframeGroup), so the button reflects
 * the union of their keys and adds or removes a key in all of them.
 */
export function useLayoutKeyframeTrack({
  clipId,
  timelineClip,
  targetTransforms,
  onSetTransforms,
  onToggleKeyframe,
}: UseLayoutKeyframeTrackInput): UseLayoutKeyframeTrackResult {
  const storeClip = useTimelineClip(clipId);
  const clip = timelineClip ?? storeClip;
  const setActiveSpline = useTransformationViewStore((state) => state.setActiveSpline);
  const enabled = !!clip;
  const targetContextId = clipId ?? clip?.id;
  const transforms = targetTransforms ?? clip?.transformations;

  const keyframeTimes = useMemo(
    () => getLayoutKeyframeTimes(transforms ?? [], POINT_EPSILON_TICKS),
    [transforms],
  );
  const keyframeTimesSignature = keyframeTimes.join(",");

  const clipRef = useRef(clip);
  const transformsRef = useRef(transforms);
  const keyframeTimesRef = useRef(keyframeTimes);
  useEffect(() => {
    clipRef.current = clip;
    transformsRef.current = transforms;
    keyframeTimesRef.current = keyframeTimes;
  }, [clip, transforms, keyframeTimes]);

  // Source-media time shown at the playhead, read by the toggle outside render.
  const keyframeTimeRef = useRef<number | null>(null);
  const activeValueRef = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled) {
      keyframeTimeRef.current = null;
      activeValueRef.current = false;
      return;
    }

    const update = (ticks: number) => {
      const currentClip = clipRef.current;
      if (!currentClip) return;
      const keyframeTime = clampedClipSourceTime(
        getTimelinePresentationContext(),
        currentClip,
        ticks,
      );
      keyframeTimeRef.current = keyframeTime;

      const nextActive = keyframeTimesRef.current.some(
        (time) => Math.abs(time - keyframeTime) <= POINT_EPSILON_TICKS,
      );
      if (nextActive !== activeValueRef.current) {
        activeValueRef.current = nextActive;
        setActive(nextActive);
      }
    };

    update(playbackClock.time);
    return playbackClock.subscribe(update);
  }, [enabled, keyframeTimesSignature]);

  const toggleKeyframe = useCallback(() => {
    const keyframeTime = keyframeTimeRef.current;
    const currentClip = clipRef.current;
    if (!currentClip || keyframeTime === null) return;
    onToggleKeyframe?.();

    const baseTransforms = transformsRef.current ?? currentClip.transformations ?? [];
    let nextTransforms: ClipTransform[];
    if (activeValueRef.current) {
      nextTransforms = removeLayoutKeyframe(
        baseTransforms,
        keyframeTime,
        POINT_EPSILON_TICKS,
      );
    } else {
      // A key needs a transform to live on. With none taking part yet, create
      // the first missing one at its defaults; absent siblings keep rendering
      // their defaults and join the track when first edited.
      let withTarget = baseTransforms;
      if (!baseTransforms.some(isLayoutKeyframeTransform)) {
        const missingType = LAYOUT_KEYFRAME_GROUP_TYPES.find(
          (type) => !baseTransforms.some((transform) => transform.type === type),
        );
        const created = missingType
          ? (createAddTransform(missingType) as ClipTransform | null)
          : null;
        if (!created) return;
        withTarget = insertTransformRespectingDefaultOrder(baseTransforms, created);
      }
      nextTransforms = addLayoutKeyframe(withTarget, keyframeTime, POINT_EPSILON_TICKS);
    }

    if (onSetTransforms) {
      onSetTransforms(nextTransforms);
    } else {
      setTimelineClipTransforms(currentClip.id, nextTransforms);
    }

    if (!activeValueRef.current && targetContextId) {
      const keyed = nextTransforms.find(isLayoutKeyframeTransform);
      if (keyed) {
        setActiveSpline({
          clipId: targetContextId,
          transformId: keyed.id,
          property: FIRST_LAYOUT_CONTROL[keyed.type] ?? "",
        });
      }
    }
  }, [onSetTransforms, onToggleKeyframe, setActiveSpline, targetContextId]);

  return { enabled, active: enabled && active, toggleKeyframe };
}
