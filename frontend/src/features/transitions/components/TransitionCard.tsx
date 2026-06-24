import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Box, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { TransitionType } from "../../../types/TimelineTypes";
import type { TransitionDefinition } from "../catalogue/TransitionRegistry";

export interface TransitionDragData {
  type: "transition";
  transitionType: TransitionType;
  label: string;
  glyph: string;
}

interface TransitionCardProps {
  definition: TransitionDefinition;
}

const CardRoot = styled("div")(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "48px minmax(0, 1fr)",
  alignItems: "center",
  gap: theme.spacing(1.25),
  minHeight: 62,
  padding: theme.spacing(1),
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  background: "#1d1f23",
  cursor: "grab",
  "&:hover": {
    borderColor: "rgba(77,171,245,0.55)",
    background: "#242832",
  },
}));

export function TransitionCardSurface({
  label,
  glyph,
  rejected = false,
}: {
  label: string;
  glyph: string;
  rejected?: boolean;
}) {
  return (
    <CardRoot
      sx={
        rejected
          ? {
              borderColor: "rgba(244,67,54,0.85)",
              bgcolor: "rgba(244,67,54,0.12)",
            }
          : undefined
      }
    >
      <Box
        sx={{
          height: 40,
          borderRadius: 1,
          display: "grid",
          placeItems: "center",
          bgcolor: "rgba(77,171,245,0.12)",
          color: "primary.light",
          fontSize: 22,
        }}
      >
        {glyph}
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {label}
      </Typography>
    </CardRoot>
  );
}

function TransitionCardComponent({ definition }: TransitionCardProps) {
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `transition_${definition.type}`,
    data: {
      type: "transition",
      transitionType: definition.type,
      label: definition.label,
      glyph: definition.glyph,
    } satisfies TransitionDragData,
  });

  return (
    <Box ref={setNodeRef} {...attributes} {...listeners}>
      <TransitionCardSurface
        label={definition.label}
        glyph={definition.glyph}
      />
    </Box>
  );
}

export const TransitionCard = memo(TransitionCardComponent);
