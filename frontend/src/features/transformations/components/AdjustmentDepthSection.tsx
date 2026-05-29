import { useEffect, useState } from "react";
import {
  Box,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_RIPPLE,
  ADJUSTMENT_RETIMING_STATIC,
  getAdjustmentRetimingMode,
  isAdjustmentDepthAll,
  type AdjustmentTimelineClip,
} from "../../../types/TimelineTypes";
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
  const setAdjustmentRetimingMode = useTimelineStore(
    (state) => state.setAdjustmentRetimingMode,
  );
  const tracksBelowCount = useTimelineStore((state) => {
    const trackIndex = state.tracks.findIndex((track) => track.id === clip.trackId);
    if (trackIndex < 0) {
      return 0;
    }
    return Math.max(0, state.tracks.length - trackIndex - 1);
  });
  const isAllTracksBelow = isAdjustmentDepthAll(clip.depth);
  const isRippleRetiming =
    getAdjustmentRetimingMode(clip) === ADJUSTMENT_RETIMING_RIPPLE;
  const fallbackNumericDepth = Math.max(1, tracksBelowCount);

  // Local draft state so the user can backspace through the value without
  // the input fighting them on each keystroke. The committed value lives
  // in the store; we just mirror it into local state on clip change.
  const [draft, setDraft] = useState<string>(
    isAllTracksBelow ? String(fallbackNumericDepth) : String(clip.depth),
  );
  useEffect(() => {
    setDraft(isAllTracksBelow ? String(fallbackNumericDepth) : String(clip.depth));
  }, [clip.depth, clip.id, fallbackNumericDepth, isAllTracksBelow]);

  const resetDraft = () => {
    setDraft(isAllTracksBelow ? String(fallbackNumericDepth) : String(clip.depth));
  };

  const commit = (raw: string) => {
    if (isAllTracksBelow) {
      resetDraft();
      return;
    }
    const next = Number.parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 1) {
      // Invalid — revert the input to the last committed value.
      resetDraft();
      return;
    }
    if (next === clip.depth) return;
    setAdjustmentDepth(clip.id, next);
  };

  const handleAllTracksToggle = (checked: boolean) => {
    if (checked) {
      if (isAllTracksBelow) return;
      setAdjustmentDepth(clip.id, ADJUSTMENT_DEPTH_ALL);
      return;
    }

    setDraft(String(fallbackNumericDepth));
    if (!isAllTracksBelow && clip.depth === fallbackNumericDepth) return;
    setAdjustmentDepth(clip.id, fallbackNumericDepth);
  };

  const handleRetimingToggle = (checked: boolean) => {
    setAdjustmentRetimingMode(
      clip.id,
      checked ? ADJUSTMENT_RETIMING_RIPPLE : ADJUSTMENT_RETIMING_STATIC,
    );
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
        Reaches every track below this lane in <strong>All</strong> mode, or
        the next <strong>depth</strong> tracks when you switch to a custom
        value. Visual tracks among those get the transforms below; non-visual
        tracks are passed through unchanged.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={isRippleRetiming}
            onChange={(_, checked) => handleRetimingToggle(checked)}
          />
        }
        label="Ripple timeline timing"
        sx={{
          mt: 0.5,
          mr: 0,
          "& .MuiFormControlLabel-label": {
            color: "#d6dade",
            fontSize: "0.875rem",
          },
        }}
      />
      <Typography variant="caption" sx={{ color: "#8f98a3", lineHeight: 1.3 }}>
        {isRippleRetiming
          ? "Speed changes stretch or contract the affected lanes, so later clips shift in presentation time."
          : "Speed changes retime covered clip content while keeping clip starts pinned on the timeline."}
      </Typography>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={isAllTracksBelow}
            onChange={(_, checked) => handleAllTracksToggle(checked)}
          />
        }
        label="All tracks below"
        sx={{
          mt: 0.5,
          mr: 0,
          "& .MuiFormControlLabel-label": {
            color: "#d6dade",
            fontSize: "0.875rem",
          },
        }}
      />
      {isAllTracksBelow ? (
        <Typography variant="body2" sx={{ color: "#d6dade" }}>
          {tracksBelowCount === 0
            ? "No tracks below this lane right now. New lower tracks will be included automatically."
            : `Currently covering ${tracksBelowCount} track${tracksBelowCount === 1 ? "" : "s"} below this lane.`}
        </Typography>
      ) : (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
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
      )}
    </Box>
  );
}
