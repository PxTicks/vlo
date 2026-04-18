import { Box, Chip, IconButton, Typography } from "@mui/material";
import { Add, DeleteOutline, EditOutlined } from "@mui/icons-material";
import type { RangeMaskDataComponent } from "../../../types/DataComponents";
import { TICKS_PER_SECOND } from "../../timeline";

interface RangeMaskSectionProps {
  rangeMaskComponents: RangeMaskDataComponent[];
  onAdd: () => void;
  onEdit: (rangeMaskId: string) => void;
  onRemove: (rangeMaskId: string) => void;
  onToggleActive: (rangeMaskId: string) => void;
}

function formatRangeLabel(
  component: RangeMaskDataComponent,
  index: number,
): string {
  const startSeconds = component.parameters.startSourceTicks / TICKS_PER_SECOND;
  const endSeconds = component.parameters.endSourceTicks / TICKS_PER_SECOND;
  return `Range ${index + 1} — ${startSeconds.toFixed(2)}s–${endSeconds.toFixed(2)}s`;
}

export function RangeMaskSection({
  rangeMaskComponents,
  onAdd,
  onEdit,
  onRemove,
  onToggleActive,
}: RangeMaskSectionProps) {
  const activeComponents = rangeMaskComponents.filter(
    (component) => component.parameters.isActive,
  );

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
          {rangeMaskComponents.map((component, index) => (
            <Box
              key={component.id}
              sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
            >
              <Chip
                data-testid={`range-mask-chip-${component.id}`}
                label={formatRangeLabel(component, index)}
                size="small"
                color={component.parameters.isActive ? "primary" : "default"}
                variant={
                  component.parameters.isActive ? "filled" : "outlined"
                }
                onClick={() => onToggleActive(component.id)}
                sx={{ height: 24 }}
              />
              <IconButton
                data-testid={`range-mask-edit-${component.id}`}
                aria-label={`Edit range mask ${index + 1}`}
                size="small"
                onClick={() => onEdit(component.id)}
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
                data-testid={`range-mask-remove-${component.id}`}
                aria-label={`Remove range mask ${index + 1}`}
                size="small"
                onClick={() => onRemove(component.id)}
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
        {activeComponents.length === 0 ? (
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
            {activeComponents.map((component) => {
              const index = rangeMaskComponents.findIndex(
                (other) => other.id === component.id,
              );
              return (
                <Chip
                  key={component.id}
                  size="small"
                  color="primary"
                  variant="filled"
                  label={formatRangeLabel(component, index)}
                  onClick={() => onToggleActive(component.id)}
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
