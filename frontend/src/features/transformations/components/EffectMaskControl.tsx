import { useState } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import { FilterAltOutlined, RemoveCircleOutline } from "@mui/icons-material";
import type {
  ClipTransform,
  EffectMask,
} from "../../../types/TimelineTypes";
import { useMaskClipsForParent } from "../../timeline";
import { EffectMaskDialog } from "./EffectMaskDialog";

interface EffectMaskControlProps {
  transform: ClipTransform;
  /** The parent (non-mask) clip whose masks this effect mask can reference. */
  clipId: string | undefined;
  /** Filter title, surfaced in the dialog. */
  transformTitle: string;
  onUpdateTransform?: (
    transformId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
}

const iconButtonSx = {
  minWidth: 0,
  p: 0.5,
  color: "text.secondary",
  "&:hover": { bgcolor: "action.hover" },
} as const;

/**
 * Per-filter effect-mask affordance. Rendered only for filter transforms (the
 * only effect-maskable transforms in v1 — speed/layout/etc. are excluded by
 * the caller). The compact icon treatment keeps the transformation controls
 * visually dominant while still surfacing mask state in the section header.
 */
export function EffectMaskControl({
  transform,
  clipId,
  transformTitle,
  onUpdateTransform,
}: EffectMaskControlProps) {
  const [open, setOpen] = useState(false);
  const masks = useMaskClipsForParent(clipId) ?? [];

  const effectMask = transform.effectMask;
  const active = !!effectMask?.enabled && !!effectMask.expression;

  const handleChange = (next: EffectMask) => {
    onUpdateTransform?.(transform.id, { effectMask: next });
  };

  const handleRemove = () => {
    // Disabled + no expression == legacy whole-clip filter (the unmasked path).
    onUpdateTransform?.(transform.id, {
      effectMask: { mode: "composite", enabled: false, expression: null },
    });
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      <Tooltip title={active ? "Edit effect mask" : "Add effect mask"}>
        <IconButton
          size="small"
          aria-label={active ? "Edit effect mask" : "Add effect mask"}
          onClick={() => setOpen(true)}
          sx={{
            ...iconButtonSx,
            color: active ? "primary.main" : "text.secondary",
          }}
          data-testid={`effect-mask-button-${transform.id}`}
        >
          <FilterAltOutlined sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      {active && (
        <Tooltip title="Remove effect mask">
          <IconButton
            size="small"
            aria-label="Remove effect mask"
            onClick={handleRemove}
            sx={{
              ...iconButtonSx,
              "&:hover": { color: "error.main", bgcolor: "error.soft" },
            }}
            data-testid={`effect-mask-remove-${transform.id}`}
          >
            <RemoveCircleOutline sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      )}
      {open && (
        <EffectMaskDialog
          open
          onClose={() => setOpen(false)}
          title={transformTitle}
          masks={masks}
          effectMask={effectMask}
          onChange={handleChange}
        />
      )}
    </Box>
  );
}
