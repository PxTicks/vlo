import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Box, Typography } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { styled } from "@mui/material/styles";
import type { TransformationDefinition } from "../../catalogue/types";

export interface TransformDragData {
  type: "transform";
  transformType: string;
  isFilter: boolean;
  label: string;
}

interface TransformationCardProps {
  definition: TransformationDefinition;
}

interface TransformationCardSurfaceProps {
  label: string;
  isDragging?: boolean;
  isRejected?: boolean;
}

const CardRoot = styled("div", {
  shouldForwardProp: (prop) =>
    prop !== "isDragging" && prop !== "isRejected",
})<{
  isDragging?: boolean;
  isRejected?: boolean;
}>(({ theme, isDragging, isRejected }) => ({
  display: "grid",
  gridTemplateColumns: "56px minmax(0, 1fr)",
  alignItems: "center",
  gap: theme.spacing(1.25),
  width: "100%",
  minHeight: 68,
  padding: theme.spacing(1),
  borderRadius: 6,
  border: `1px solid ${
    isRejected ? "rgba(244, 67, 54, 0.85)" : "rgba(255, 255, 255, 0.12)"
  }`,
  background: isRejected ? "rgba(244, 67, 54, 0.12)" : "#1d1f23",
  color: "#f5f7fa",
  boxShadow: isDragging ? "0 8px 20px rgba(0,0,0,0.35)" : "none",
  opacity: isDragging ? 0.48 : 1,
  cursor: isDragging ? "grabbing" : "grab",
  transition: "border-color 120ms ease, background-color 120ms ease",
  "&:hover": {
    borderColor: isRejected
      ? "rgba(244, 67, 54, 0.95)"
      : "rgba(77, 171, 245, 0.55)",
    background: isRejected ? "rgba(244, 67, 54, 0.16)" : "#242832",
  },
}));

const PreviewSlot = styled("div")(({ theme }) => ({
  width: 56,
  height: 44,
  borderRadius: 4,
  border: "1px solid rgba(255, 255, 255, 0.1)",
  background:
    "linear-gradient(135deg, rgba(77,171,245,0.14), rgba(255,255,255,0.05))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: theme.palette.primary.light,
}));

export function TransformationCardSurface({
  label,
  isDragging = false,
  isRejected = false,
}: TransformationCardSurfaceProps) {
  return (
    <CardRoot isDragging={isDragging} isRejected={isRejected}>
      <PreviewSlot>
        {/* TODO: live video preview */}
        <AutoFixHighIcon fontSize="small" />
      </PreviewSlot>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </Typography>
      </Box>
    </CardRoot>
  );
}

function TransformationCardComponent({ definition }: TransformationCardProps) {
  const transformType = definition.filterName ?? definition.type;
  const isFilter = definition.type === "filter";
  const draggableId = `transform_${transformType}`;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: draggableId,
    data: {
      type: "transform",
      transformType,
      isFilter,
      label: definition.label,
    } satisfies TransformDragData,
  });

  return (
    <Box ref={setNodeRef} {...listeners} {...attributes}>
      <TransformationCardSurface
        label={definition.label}
        isDragging={isDragging}
      />
    </Box>
  );
}

export const TransformationCard = memo(TransformationCardComponent);
