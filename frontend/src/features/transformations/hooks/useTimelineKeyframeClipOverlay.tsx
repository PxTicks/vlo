import { useMemo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useShallow } from "zustand/react/shallow";
import type { TimelineClipOverlayDefinition } from "../../timeline/clipOverlayApi";
import { createLayerTimeOverlayItem } from "../../timeline/clipOverlayApi";
import {
  parseMaskClipId,
  selectMaskClipsForParent,
  useTimelineStore,
} from "../../timeline/useTimelineStore";
import { useTimelineViewStore } from "../../timeline/hooks/useTimelineViewStore";
import { buildFrameSnappedLayerTimeDrag } from "../../timeline/utils/snapDragOverlay";
import { useProjectStore } from "../../project/useProjectStore";
import { getTicksPerFrame } from "../../timelineSelection";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { isSplineParameter } from "../types";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { collectSectionKeyframes } from "../utils/sectionKeyframes";

const POINT_EPSILON_TICKS = 1;

const DiamondMarker = styled(Box)(() => ({
  width: 8,
  height: 8,
  transform: "rotate(45deg)",
  border: "1px solid rgba(0,0,0,0.65)",
  boxShadow: "0 0 4px rgba(0,0,0,0.5)",
  pointerEvents: "none",
}));

function resolveKeyframeLane(
  groupIndex: number,
  maxGroupIndex: number,
): "top" | "middle" | "bottom" {
  if (maxGroupIndex <= 0) {
    return "middle";
  }

  if (maxGroupIndex === 1) {
    return groupIndex === 0 ? "top" : "bottom";
  }

  if (groupIndex <= 0) {
    return "top";
  }

  if (groupIndex >= maxGroupIndex) {
    return "bottom";
  }

  return "middle";
}

function resolveActiveClipKeyframes(
  clip: TimelineClip,
  maskClips: TimelineClip[],
  activeSection: { clipId: string; sectionId: string } | null,
) {
  if (!activeSection) {
    return [];
  }

  if (activeSection.clipId === clip.id) {
    return collectSectionKeyframes(clip, activeSection.sectionId);
  }

  const parsedMaskClipId = parseMaskClipId(activeSection.clipId);
  if (!parsedMaskClipId || parsedMaskClipId.clipId !== clip.id) {
    return [];
  }

  const maskClip = maskClips.find((candidate) => candidate.id === activeSection.clipId);
  if (!maskClip) {
    return [];
  }

  return collectSectionKeyframes(maskClip, activeSection.sectionId);
}

function resolveHostClip(
  clip: TimelineClip,
  maskClips: TimelineClip[],
  activeSection: { clipId: string; sectionId: string } | null,
): TimelineClip | null {
  if (!activeSection) return null;
  if (activeSection.clipId === clip.id) return clip;
  return (
    maskClips.find((candidate) => candidate.id === activeSection.clipId) ?? null
  );
}

function findNeighborInputTimes(
  transform: ClipTransform | undefined,
  inputTime: number,
): { prev: number | null; next: number | null } {
  const times = transform?.keyframeTimes ?? [];
  if (times.length === 0) return { prev: null, next: null };

  // `keyframeTimes` is maintained sorted; locate the dragged entry by
  // tolerant equality so we don't trip on float drift.
  const sorted = [...times].sort((a, b) => a - b);
  const index = sorted.findIndex(
    (t) => Math.abs(t - inputTime) <= POINT_EPSILON_TICKS,
  );
  if (index === -1) return { prev: null, next: null };

  return {
    prev: index > 0 ? sorted[index - 1] : null,
    next: index < sorted.length - 1 ? sorted[index + 1] : null,
  };
}

function commitKeyframeMove(
  hostClipId: string,
  transformId: string,
  oldInputTime: number,
  newInputTime: number,
): void {
  const store = useTimelineStore.getState();
  const hostClip = store.clips.find((candidate) => candidate.id === hostClipId);
  if (!hostClip) return;
  const transform = hostClip.transformations.find((t) => t.id === transformId);
  if (!transform) return;

  if (Math.abs(newInputTime - oldInputTime) <= POINT_EPSILON_TICKS) return;

  const nextTimes = (transform.keyframeTimes ?? [])
    .map((time) =>
      Math.abs(time - oldInputTime) <= POINT_EPSILON_TICKS ? newInputTime : time,
    )
    .sort((a, b) => a - b);

  const nextParameters: Record<string, unknown> = {};
  Object.entries(transform.parameters).forEach(([key, value]) => {
    if (!isSplineParameter(value)) {
      nextParameters[key] = value;
      return;
    }
    const newPoints = value.points
      .map((point) =>
        Math.abs(point.time - oldInputTime) <= POINT_EPSILON_TICKS
          ? { ...point, time: newInputTime }
          : point,
      )
      .sort((a, b) => a.time - b.time);
    nextParameters[key] = { type: "spline" as const, points: newPoints };
  });

  store.updateClipTransform(hostClipId, transformId, {
    parameters: nextParameters,
    keyframeTimes: nextTimes,
  });
}

function useKeyframeOverlayItems({
  clip,
}: {
  clip: TimelineClip;
  isSelected: boolean;
}) {
  const activeSection = useTransformationViewStore((state) => {
    const currentActiveSection = state.activeSection;
    if (!currentActiveSection) {
      return null;
    }

    if (currentActiveSection.clipId === clip.id) {
      return currentActiveSection;
    }

    const parsedMaskClipId = parseMaskClipId(currentActiveSection.clipId);
    if (parsedMaskClipId?.clipId === clip.id) {
      return currentActiveSection;
    }

    return null;
  });

  const maskClips = useTimelineStore(
    useShallow((state) => selectMaskClipsForParent(state, clip.id)),
  );

  return useMemo(() => {
    const keyframes = resolveActiveClipKeyframes(clip, maskClips, activeSection);
    if (keyframes.length === 0) {
      return [];
    }

    const hostClip = resolveHostClip(clip, maskClips, activeSection);

    const maxGroupIndex = keyframes.reduce(
      (largestGroupIndex, marker) =>
        Math.max(largestGroupIndex, marker.groupIndex),
      0,
    );

    return keyframes.map((marker) => {
      const dragHandlers = hostClip
        ? buildFrameSnappedLayerTimeDrag({
            clip: hostClip,
            transformId: marker.transformId,
            initialLayerInputTicks: marker.inputTime,
            ...(() => {
              const transform = hostClip.transformations.find(
                (t) => t.id === marker.transformId,
              );
              const { prev, next } = findNeighborInputTimes(
                transform,
                marker.inputTime,
              );
              return {
                prevNeighborLayerInputTicks: prev,
                nextNeighborLayerInputTicks: next,
              };
            })(),
            getTicksPerFrame: () =>
              getTicksPerFrame(useProjectStore.getState().config.fps),
            getZoomScale: () => useTimelineViewStore.getState().zoomScale,
            onCommit: (snappedLayerInputTicks) => {
              commitKeyframeMove(
                hostClip.id,
                marker.transformId,
                marker.inputTime,
                snappedLayerInputTicks,
              );
            },
          })
        : undefined;

      return createLayerTimeOverlayItem({
        id: marker.id,
        transformId: marker.transformId,
        layerInputTicks: marker.inputTime,
        lane: resolveKeyframeLane(marker.groupIndex, maxGroupIndex),
        content: (
          <DiamondMarker
            sx={{
              backgroundColor: marker.color,
              cursor: dragHandlers ? "default" : undefined,
            }}
          />
        ),
        drag: dragHandlers,
      });
    });
  }, [activeSection, clip, maskClips]);
}

const TIMELINE_KEYFRAME_CLIP_OVERLAY: TimelineClipOverlayDefinition = {
  id: "timeline-keyframe-overlay",
  useItems: useKeyframeOverlayItems,
};

export function useTimelineKeyframeClipOverlay(): TimelineClipOverlayDefinition {
  return TIMELINE_KEYFRAME_CLIP_OVERLAY;
}
