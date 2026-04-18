import { Box, Chip, IconButton, Typography } from "@mui/material";
import { Add, DeleteOutline } from "@mui/icons-material";
import type { RangeMask } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

interface RangeMaskSectionProps {
  rangeMasks: RangeMask[];
  activeRangeMaskIds: string[];
  onAdd: () => void;
  onRemove: (rangeMaskId: string) => void;
  onToggleActive: (rangeMaskId: string) => void;
}

function formatRangeLabel(mask: RangeMask, index: number): string {
  const startSeconds = mask.startSourceTicks / TICKS_PER_SECOND;
  const endSeconds = mask.endSourceTicks / TICKS_PER_SECOND;
  return `Range ${index + 1} — ${startSeconds.toFixed(2)}s–${endSeconds.toFixed(2)}s`;
}

export function RangeMaskSection({
  rangeMasks,
  activeRangeMaskIds,
  onAdd,
  onRemove,
  onToggleActive,
}: RangeMaskSectionProps) {
  const activeSet = new Set(activeRangeMaskIds);

  return (
    <Box
      sx={{ px: 2, pb: 2, display: "flex", flexDirection: "column", gap: 1.5 }}
    >
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block" }}
      >
        Range Masks
      </Typography>

      <Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Available Ranges
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, width: "100%" }}>
          {rangeMasks.map((mask, index) => (
            <Box
              key={mask.id}
              sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
            >
              <Chip
                data-testid={`range-mask-chip-${mask.id}`}
                label={formatRangeLabel(mask, index)}
                size="small"
                color={activeSet.has(mask.id) ? "primary" : "default"}
                variant={activeSet.has(mask.id) ? "filled" : "outlined"}
                onClick={() => onToggleActive(mask.id)}
                sx={{ height: 24 }}
              />
              <IconButton
                data-testid={`range-mask-remove-${mask.id}`}
                aria-label={`Remove range mask ${index + 1}`}
                size="small"
                onClick={() => onRemove(mask.id)}
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
          ))}
          <Chip
            data-testid="range-mask-add-chip"
            label="Add range"
            size="small"
            variant="outlined"
            icon={<Add sx={{ fontSize: "1rem !important" }} />}
            onClick={onAdd}
            sx={{ fontSize: "0.75rem", height: 24, cursor: "pointer" }}
          />
        </Box>
      </Box>

      <Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Active Ranges
        </Typography>
        {activeRangeMaskIds.length === 0 ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", minHeight: 20 }}
          >
            No active ranges. Click a range chip to activate it.
          </Typography>
        ) : (
          <Box
            data-testid="range-mask-active-list"
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 1,
              minHeight: 32,
              alignItems: "center",
            }}
          >
            {activeRangeMaskIds.map((id) => {
              const maskIndex = rangeMasks.findIndex((m) => m.id === id);
              if (maskIndex === -1) return null;
              const mask = rangeMasks[maskIndex];
              return (
                <Chip
                  key={id}
                  size="small"
                  color="primary"
                  variant="filled"
                  label={formatRangeLabel(mask, maskIndex)}
                  onClick={() => onToggleActive(id)}
                  sx={{ height: 24 }}
                />
              );
            })}
          </Box>
        )}
      </Box>

      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        Active ranges make the clip transparent for their time window (union
        semantics — any active range hides the clip there).
      </Typography>
    </Box>
  );
}
