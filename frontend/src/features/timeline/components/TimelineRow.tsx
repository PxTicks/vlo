// components/Timeline/TimelineRow.tsx
import React, { memo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineBody } from "./TimelineBody";
import { getTrackColor } from "../utils/formatting";
import { TRACK_HEIGHT } from "../constants";
import type { TrackType, TimelineTrack } from "../../../types/TimelineTypes";

interface TimelineRowProps {
  track: TimelineTrack;
  index: number;
  onToggleVisibility: (id: string) => void;
  onToggleMute?: (id: string) => void;
}

const StyledRow = styled(Box)({
  display: "flex",
  height: TRACK_HEIGHT,
  backgroundColor: "transparent",
});

function TimelineRowComponent({
  track,
  index,
  onToggleVisibility,
  onToggleMute,
}: TimelineRowProps) {
  // Optimization: Removed subscription to clips.
  // We rely on track.type being updated by the store when clips are added/moved.
  const derivedType: TrackType | null = track.type || null;
  const trackColor = derivedType ? getTrackColor(derivedType) : "#444";

  const handleToggleVisibility = React.useCallback(
    () => onToggleVisibility(track.id),
    [track.id, onToggleVisibility],
  );

  const handleToggleMute = React.useCallback(
    () => onToggleMute && onToggleMute(track.id),
    [track.id, onToggleMute],
  );

  return (
    <StyledRow data-testid="timeline-row">
      <TimelineHeader
        isVisible={track.isVisible}
        isMuted={track.isMuted}
        derivedType={derivedType}
        color={trackColor}
        onToggleVisibility={handleToggleVisibility}
        onToggleMute={handleToggleMute}
      />

      <TimelineBody
        trackId={track.id}
        isAlternate={index % 2 === 0}
        isVisible={track.isVisible}
      />
    </StyledRow>
  );
}

export const TimelineRow = memo(TimelineRowComponent);
