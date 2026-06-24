import { memo } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { ResolvedTransition } from "../../timeline/model/transitionModel";
import { RULER_HEIGHT, TRACK_HEIGHT } from "../../timeline/constants";
import { timelineSpanStyleX } from "../../timeline/utils/timelineGeometry";
import { getTransitionDefinition } from "../catalogue/TransitionRegistry";

const OverlayRoot = styled("button")(({ theme }) => ({
  position: "absolute",
  padding: 0,
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 5,
  background:
    "linear-gradient(135deg, rgba(77,171,245,0.4), rgba(156,39,176,0.35))",
  color: theme.palette.common.white,
  cursor: "pointer",
  pointerEvents: "auto",
  overflow: "hidden",
  zIndex: 20,
  "&:hover": {
    borderColor: theme.palette.primary.light,
  },
}));

interface TransitionOverlayProps {
  resolved: ResolvedTransition;
  selected: boolean;
  onSelect: (transitionId: string) => void;
}

function TransitionOverlayComponent({
  resolved,
  selected,
  onSelect,
}: TransitionOverlayProps) {
  const definition = getTransitionDefinition(resolved.transition.type);
  const topTrackIndex = Math.min(
    resolved.outgoingTrackIndex,
    resolved.incomingTrackIndex,
  );

  // Scaled via `--timeline-zoom` so the memoized overlay re-positions on zoom
  // in CSS without needing a React re-render.
  const spanStyle = timelineSpanStyleX(resolved.start, resolved.duration, {
    headerOffset: true,
    minWidthPx: 20,
  });

  return (
    <OverlayRoot
      type="button"
      aria-label={`${definition.label} transition`}
      data-testid={`transition-overlay-${resolved.transition.id}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(resolved.transition.id);
      }}
      style={{
        ...spanStyle,
        top: RULER_HEIGHT + topTrackIndex * TRACK_HEIGHT + 5,
        height: TRACK_HEIGHT * 2 - 10,
        boxShadow: selected
          ? "0 0 0 2px #4dabf5, 0 0 16px rgba(77,171,245,0.5)"
          : undefined,
      }}
    >
      <Box
        component="span"
        sx={{
          display: "grid",
          placeItems: "center",
          width: "100%",
          height: "100%",
          fontSize: 20,
          textShadow: "0 1px 3px rgba(0,0,0,0.8)",
        }}
      >
        {definition.glyph}
      </Box>
    </OverlayRoot>
  );
}

export const TransitionOverlay = memo(TransitionOverlayComponent);
