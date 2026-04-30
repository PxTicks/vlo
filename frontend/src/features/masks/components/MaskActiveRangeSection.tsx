import { Box, Chip, IconButton, Typography } from "@mui/material";
import { Add, DeleteOutline, EditOutlined } from "@mui/icons-material";
import type { MaskActiveRange } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

interface MaskActiveRangeSectionProps {
  activeRange: MaskActiveRange | null;
  onAdd: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function formatRangeLabel(range: MaskActiveRange): string {
  const startSeconds = range.startSourceTicks / TICKS_PER_SECOND;
  const endSeconds = range.endSourceTicks / TICKS_PER_SECOND;
  return `${startSeconds.toFixed(2)}s–${endSeconds.toFixed(2)}s`;
}

export function MaskActiveRangeSection({
  activeRange,
  onAdd,
  onEdit,
  onRemove,
}: MaskActiveRangeSectionProps) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block" }}
      >
        Active Range
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", display: "block" }}
      >
        Limit when this mask is applied. Outside the range it's a no-op.
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {activeRange ? (
          <Box
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
          >
            <Chip
              data-testid="mask-active-range-chip"
              label={formatRangeLabel(activeRange)}
              size="small"
              color="primary"
              variant="filled"
              sx={{ height: 24 }}
            />
            <IconButton
              data-testid="mask-active-range-edit"
              aria-label="Edit mask active range"
              size="small"
              onClick={onEdit}
              sx={{
                border: "1px solid",
                borderColor: "#2f333a",
                borderRadius: 999,
                p: 0.5,
              }}
            >
              <EditOutlined sx={{ fontSize: 14 }} />
            </IconButton>
            <IconButton
              data-testid="mask-active-range-remove"
              aria-label="Remove mask active range"
              size="small"
              onClick={onRemove}
              sx={{
                border: "1px solid",
                borderColor: "#2f333a",
                borderRadius: 999,
                p: 0.5,
              }}
            >
              <DeleteOutline sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        ) : (
          <Chip
            data-testid="mask-active-range-add"
            label="Set active range"
            size="small"
            variant="outlined"
            icon={<Add sx={{ fontSize: "1rem !important" }} />}
            onClick={onAdd}
            sx={{ fontSize: "0.75rem", height: 24, cursor: "pointer" }}
          />
        )}
      </Box>
    </Box>
  );
}
