import { useMemo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  collectSectionKeyframes,
  useTransformationViewStore,
} from "../../transformations";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND, PIXELS_PER_SECOND } from "../constants";
import {
  useTimelineStore,
  parseMaskClipId,
  selectMaskClipsForParent,
} from "../useTimelineStore";
import { useShallow } from "zustand/react/shallow";

interface SplineOverlayProps {
  clip: TimelineClip;
}

const DiamondMarker = styled(Box)(() => ({
  position: "absolute",
  width: 8,
  height: 8,
  transform: "translate(-50%, -50%) rotate(45deg)",
  border: "1px solid rgba(0,0,0,0.65)",
  boxShadow: "0 0 4px rgba(0,0,0,0.5)",
  zIndex: 15,
  pointerEvents: "none", // Purely visual for now
}));

export function SplineOverlay({ clip }: SplineOverlayProps) {
  const activeSection = useTransformationViewStore(
    (state) => state.activeSection,
  );

  const maskClips = useTimelineStore(
    useShallow((state) => selectMaskClipsForParent(state, clip.id)),
  );

  const keyframes = useMemo(() => {
    if (!activeSection) {
      return [];
    }

    if (activeSection.clipId === clip.id) {
      return collectSectionKeyframes(clip, activeSection.sectionId);
    }

    // Check if the active section targets a mask clip of this parent
    const parsed = parseMaskClipId(activeSection.clipId);
    if (!parsed || parsed.clipId !== clip.id) {
      return [];
    }

    const maskClip = maskClips.find((c) => c.id === activeSection.clipId);
    if (!maskClip) return [];

    return collectSectionKeyframes(maskClip, activeSection.sectionId);
  }, [activeSection, clip, maskClips]);

  const maxGroupIndex = useMemo(
    () =>
      keyframes.reduce(
        (largestGroupIndex, marker) =>
          Math.max(largestGroupIndex, marker.groupIndex),
        0,
      ),
    [keyframes],
  );

  if (keyframes.length === 0) return null;

  const getMarkerTop = (groupIndex: number) => {
    if (maxGroupIndex === 0) return "50%";
    const topStart = 30;
    const topEnd = 70;
    const step = (topEnd - topStart) / maxGroupIndex;
    return `${topStart + step * groupIndex}%`;
  };

  return (
    <>
      {keyframes.map((marker) => {
        const visualOffsetSeconds = marker.visualTime / TICKS_PER_SECOND;

        const baseLeft = visualOffsetSeconds * PIXELS_PER_SECOND;

        return (
          <DiamondMarker
            key={marker.id}
            style={{
              left: `calc(${baseLeft}px * var(--timeline-zoom, 1))`,
              top: getMarkerTop(marker.groupIndex),
              backgroundColor: marker.color,
            }}
          />
        );
      })}
    </>
  );
}
