import { Box, Button, Popover, Typography } from "@mui/material";
import { SplineGraph } from "./SplineEditor";
import type { ScalarParameter, SplineParameter } from "../types";
import { isSplineParameter } from "../types";
import type { ControlDefinition } from "../../panelUI/types";
import type { GraphTimeAxis } from "../utils/clipTimeDomains";
import { ExtensionScalarEditor } from "./ExtensionScalarEditor";
import { ExtensionAnimationSourceSelector } from "./ExtensionAnimationSourceSelector";

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
  timeAxis?: GraphTimeAxis;
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
  timeAxis,
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
        {isSpline && (
          <ExtensionAnimationSourceSelector
            value={value as ScalarParameter}
            minTime={minTime}
            duration={duration}
            onChange={onCommit as (nextValue: ScalarParameter) => void}
          />
        )}
        <Box
          sx={{
            height: 250,
            width: "100%",
            display: "flex",
            justifyContent: "center",
          }}
        >
          {isSpline && isSplineParameter(value) && (
            <SplineGraph
              value={value}
              onChange={onCommit as (v: SplineParameter) => void}
              width={400}
              height={250}
              minTime={minTime}
              duration={duration}
              timeAxis={timeAxis}
              minY={control.min ?? 0}
              maxY={control.max ?? 2}
              softMin={control.softMin}
              softMax={control.softMax}
            />
          )}
          {isSpline && !isSplineParameter(value) && (
            <ExtensionScalarEditor
              value={value as ScalarParameter}
              onChange={onCommit as (nextValue: ScalarParameter) => void}
              minTime={minTime}
              duration={duration}
              minValue={control.min}
              maxValue={control.max}
              softMinValue={control.softMin}
              softMaxValue={control.softMax}
              width={400}
              height={250}
              timeAxis={timeAxis}
            />
          )}
        </Box>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Button onClick={onClear} color="warning" size="small">
            Clear
          </Button>
          {isSplineParameter(value) && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Right-click to delete points
            </Typography>
          )}
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
