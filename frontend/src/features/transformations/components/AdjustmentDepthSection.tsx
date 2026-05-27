import { useEffect, useState } from "react";
import { Box, TextField, Typography } from "@mui/material";
import type { AdjustmentTimelineClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../../timeline";

interface AdjustmentDepthSectionProps {
  clip: AdjustmentTimelineClip;
}

/**
 * Structural control above the transformation list shown only for
 * adjustment clips. Drives `setAdjustmentDepth` directly.
 *
 * Depth ≥ 1 is enforced at the store layer; the input also clamps locally
 * so the user can't commit a value the store would reject. Empty input is
 * treated as "still editing" — we don't dispatch until the user types
 * something valid.
 */
export function AdjustmentDepthSection({ clip }: AdjustmentDepthSectionProps) {
  const setAdjustmentDepth = useTimelineStore(
    (state) => state.setAdjustmentDepth,
  );

  // Local draft state so the user can backspace through the value without
  // the input fighting them on each keystroke. The committed value lives
  // in the store; we just mirror it into local state on clip change.
  const [draft, setDraft] = useState<string>(String(clip.depth));
  useEffect(() => {
    setDraft(String(clip.depth));
  }, [clip.depth, clip.id]);

  const commit = (raw: string) => {
    const next = Number.parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 1) {
      // Invalid — revert the input to the last committed value.
      setDraft(String(clip.depth));
      return;
    }
    if (next === clip.depth) return;
    setAdjustmentDepth(clip.id, next);
  };

  return (
    <Box
      data-testid="adjustment-depth-section"
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        p: 1.5,
        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
        bgcolor: "rgba(95, 168, 255, 0.04)",
      }}
    >
      <Typography
        variant="caption"
        sx={{ color: "#5fa8ff", fontWeight: 700, letterSpacing: 0.5 }}
      >
        ADJUSTMENT
      </Typography>
      <Typography variant="caption" sx={{ color: "#aeb4bd", lineHeight: 1.3 }}>
        Reaches the next <strong>depth</strong> tracks below this one.
        Visual tracks among those get the transforms below; non-visual
        tracks are passed through unchanged.
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
        <Typography variant="body2" sx={{ color: "#d6dade" }}>
          Depth
        </Typography>
        <TextField
          size="small"
          type="number"
          value={draft}
          inputProps={{ min: 1, step: 1 }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.target as HTMLInputElement).blur();
            }
          }}
          sx={{
            width: 80,
            "& .MuiInputBase-input": { color: "#f5f5f5", py: 0.5 },
          }}
        />
      </Box>
    </Box>
  );
}
