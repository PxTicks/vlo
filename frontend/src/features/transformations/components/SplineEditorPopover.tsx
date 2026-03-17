import { Box, Button, Popover, Typography } from "@mui/material";
import { SplineGraph } from "./SplineEditor";
import type { SplineParameter } from "../types";
import type { ControlDefinition } from "../../panelUI/types";

interface SplineEditorPopoverProps {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  onAccept: () => void;
  onCancel: () => void;
  onClear: () => void;
  isSpline: boolean;
  value: unknown;
  onCommit: (val: unknown) => void;
  control: ControlDefinition;
  minTime: number;
  duration: number;
}

export function SplineEditorPopover({
  open,
  anchorEl,
  onAccept,
  onCancel,
  onClear,
  isSpline,
  value,
  onCommit,
  control,
  minTime,
  duration,
}: SplineEditorPopoverProps) {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onCancel}
      anchorOrigin={{
        vertical: "bottom",
        horizontal: "right",
      }}
      transformOrigin={{
        vertical: "top",
        horizontal: "right",
      }}
    >
      <Box
        sx={{
          p: 2,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 400,
        }}
      >
        <Box
          sx={{
            height: 250,
            width: "100%",
            display: "flex",
            justifyContent: "center",
          }}
        >
          {isSpline && (
            <SplineGraph
              value={value as SplineParameter}
              onChange={onCommit as (v: SplineParameter) => void}
              width={400}
              height={250}
              minTime={minTime}
              duration={duration}
              minY={control.min ?? 0}
              maxY={control.max ?? 2}
              softMin={control.softMin}
              softMax={control.softMax}
            />
          )}
        </Box>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Button onClick={onClear} color="warning" size="small">
            Clear
          </Button>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Right-click to delete points
          </Typography>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button onClick={onCancel} size="small">
              Cancel
            </Button>
            <Button onClick={onAccept} variant="contained" size="small">
              Accept
            </Button>
          </Box>
        </Box>
      </Box>
    </Popover>
  );
}
