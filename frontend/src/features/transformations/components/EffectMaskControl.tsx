import { useState } from "react";
import { Box, Button } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type {
  ClipTransform,
  EffectMask,
} from "../../../types/TimelineTypes";
import { useTimelineStore, selectMaskClipsForParent } from "../../timeline";
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

const buttonSx = {
  minWidth: 0,
  px: 0.75,
  py: 0.25,
  textTransform: "none",
  fontSize: "0.7rem",
  lineHeight: 1.2,
} as const;

/**
 * Per-filter effect-mask affordance, styled like the layout "Record Path"
 * action: a small text button that opens {@link EffectMaskDialog} to author the
 * filter's mask equation. Rendered only for filter transforms (the only
 * effect-maskable transforms in v1 — speed/layout/etc. are excluded by the
 * caller). When a mask is active it also offers an inline Remove, mirroring the
 * Record Path → Edit/Remove progression.
 */
export function EffectMaskControl({
  transform,
  clipId,
  transformTitle,
  onUpdateTransform,
}: EffectMaskControlProps) {
  const [open, setOpen] = useState(false);
  const masks =
    useTimelineStore(
      useShallow((state) =>
        clipId ? selectMaskClipsForParent(state, clipId) : [],
      ),
    ) ?? [];

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
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
      <Button
        size="small"
        onClick={() => setOpen(true)}
        sx={buttonSx}
        data-testid={`effect-mask-button-${transform.id}`}
      >
        {active ? "Edit mask" : "Add mask"}
      </Button>
      {active && (
        <Button
          size="small"
          color="error"
          onClick={handleRemove}
          sx={buttonSx}
          data-testid={`effect-mask-remove-${transform.id}`}
        >
          Remove mask
        </Button>
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
