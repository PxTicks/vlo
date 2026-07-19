// components/Timeline/TimelineRow.tsx
import React, { memo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import { useHostContextMenu } from "../../../core/shell/useHostContextMenu";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";
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

  // The wave-2 track header menu (plan §3.5): descriptor-first — the header
  // never had a hand-rolled menu to convert.
  const showContextMenu = useHostContextMenu();
  const handleHeaderContextMenu = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const showVisibility = derivedType !== "audio";
      const showMute = derivedType === "visual" || derivedType === "audio";
      const items: HostMenuItemDescriptor[] = [
        ...(showVisibility
          ? [
              {
                kind: "command",
                id: "toggle-visibility",
                command: "timeline.track.toggle-visibility",
                subject: { trackId: track.id },
                label: track.isVisible ? "Hide track" : "Show track",
                icon: track.isVisible ? (
                  <VisibilityOffIcon fontSize="small" />
                ) : (
                  <VisibilityIcon fontSize="small" />
                ),
                group: "1_track",
              } satisfies HostMenuItemDescriptor,
            ]
          : []),
        ...(showMute
          ? [
              {
                kind: "command",
                id: "toggle-mute",
                command: "timeline.track.toggle-mute",
                subject: { trackId: track.id },
                label: track.isMuted ? "Unmute track" : "Mute track",
                icon: track.isMuted ? (
                  <VolumeUpIcon fontSize="small" />
                ) : (
                  <VolumeOffIcon fontSize="small" />
                ),
                group: "1_track",
              } satisfies HostMenuItemDescriptor,
            ]
          : []),
      ];
      showContextMenu({
        menuId: "timeline.track.context",
        subject: {
          slot: "timeline.track.context",
          track: {
            id: track.id,
            label: track.label,
            type: track.type ?? "",
            isVisible: track.isVisible,
            isMuted: track.isMuted ?? false,
            isLocked: track.isLocked ?? false,
          },
        },
        items,
        position: { x: event.clientX, y: event.clientY },
      });
    },
    [track, derivedType, showContextMenu],
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
        onContextMenu={handleHeaderContextMenu}
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
