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
  selectionIncludeModeEnabled?: boolean;
  isIncludedInSelection?: boolean;
  onToggleVisibility: (id: string) => void;
  onToggleMute?: (id: string) => void;
  onToggleSelectionInclude?: (id: string) => void;
}

const StyledRow = styled(Box)({
  display: "flex",
  height: TRACK_HEIGHT,
  backgroundColor: "transparent",
});

function TimelineRowComponent({
  track,
  index,
  selectionIncludeModeEnabled = false,
  isIncludedInSelection = false,
  onToggleVisibility,
  onToggleMute,
  onToggleSelectionInclude,
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

  const handleToggleSelectionInclude = React.useCallback(
    () => onToggleSelectionInclude && onToggleSelectionInclude(track.id),
    [onToggleSelectionInclude, track.id],
  );

  return (
    <StyledRow data-testid="timeline-row">
      <TimelineHeader
        isVisible={track.isVisible}
        isMuted={track.isMuted}
        derivedType={derivedType}
        color={trackColor}
        selectionIncludeModeEnabled={selectionIncludeModeEnabled}
        isIncludedInSelection={isIncludedInSelection}
        onToggleVisibility={handleToggleVisibility}
        onToggleMute={handleToggleMute}
        onToggleSelectionInclude={handleToggleSelectionInclude}
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
