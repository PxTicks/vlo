import React, { memo, useMemo } from "react";
import { Box, IconButton, Typography } from "@mui/material";
import type { LayoutGroup, ControlRenderProps } from "../types";

interface ControlGroupProps {
  group: LayoutGroup;
  values: Record<string, unknown>;
  onCommit: (groupId: string, controlName: string, value: unknown) => void;
  renderControl: (props: ControlRenderProps) => React.ReactNode;
  keyframe?: {
    enabled: boolean;
    active: boolean;
    onToggle: () => void;
    color?: string;
  };
}

export const ControlGroup = memo(function ControlGroup({
  group,
  values,
  onCommit,
  renderControl,
  keyframe,
}: ControlGroupProps) {
  // Resolve display values by applying valueTransform.toView
  const displayValues = useMemo(() => {
    const result: Record<string, unknown> = {};
    group.controls.forEach((control) => {
      const val = values[control.name] ?? control.defaultValue;

      if (control.valueTransform?.toView) {
        // Duck-type check for spline-shaped values: { type: "spline", points: [...] }
        if (
          typeof val === "object" &&
          val !== null &&
          "type" in val &&
          (val as { type: string }).type === "spline" &&
          "points" in val
        ) {
          const splineVal = val as {
            type: "spline";
            points: Array<{ time: number; value: number }>;
          };
          result[control.name] = {
            ...splineVal,
            points: splineVal.points.map((p) => ({
              ...p,
              value: control.valueTransform!.toView(p.value),
            })),
          };
        } else {
          result[control.name] = control.valueTransform.toView(val);
        }
      } else {
        result[control.name] = val;
      }
    });
    return result;
  }, [group, values]);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block" }}
        >
          {group.title}
        </Typography>
        {keyframe?.enabled ? (
          <IconButton
            size="small"
            onClick={keyframe.onToggle}
            title={
              keyframe.active
                ? "Keyframe exists at playhead"
                : "Add keyframe at playhead"
            }
            sx={{ p: 0.25 }}
          >
            <Box
              sx={(theme) => ({
                width: 8,
                height: 8,
                transform: "rotate(45deg)",
                backgroundColor: keyframe.active
                  ? keyframe.color ?? theme.palette.secondary.main
                  : "transparent",
                border: `1px solid ${keyframe.color ?? theme.palette.text.secondary}`,
                boxShadow: keyframe.active ? "0 0 4px rgba(0,0,0,0.5)" : "none",
              })}
            />
          </IconButton>
        ) : null}
      </Box>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns:
            typeof group.columns === "string"
              ? group.columns
              : `repeat(${group.columns || 1}, 1fr)`,
          gap: 1,
          alignItems: "center",
        }}
      >
        {group.controls.map((control) => (
          <React.Fragment key={control.name}>
            {renderControl({
              control,
              value: displayValues[control.name],
              onCommit: (val: unknown) => onCommit(group.id, control.name, val),
              groupId: group.id,
            })}
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
});
