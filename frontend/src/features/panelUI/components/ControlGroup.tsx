import React, { memo, useMemo } from "react";
import { Box, IconButton, Typography } from "@mui/material";
import type { LayoutGroup, ControlRenderProps } from "../types";

interface ControlGroupProps {
  group: LayoutGroup;
  values: Record<string, unknown>;
  onCommit: (groupId: string, controlName: string, value: unknown) => void;
  onCommitMany?: (
    groupId: string,
    values: Readonly<Record<string, unknown>>,
  ) => void;
  renderControl: (props: ControlRenderProps) => React.ReactNode;
  headerActions?: React.ReactNode;
  disabled?: boolean;
  hideTitle?: boolean;
  keyframe?: {
    enabled: boolean;
    active: boolean;
    onToggle: () => void;
    color?: string;
    disabled?: boolean;
  };
}

export const ControlGroup = memo(function ControlGroup({
  group,
  values,
  onCommit,
  onCommitMany,
  renderControl,
  headerActions,
  disabled = false,
  hideTitle = false,
  keyframe,
}: ControlGroupProps) {
  // Resolve display values by applying valueTransform.toView
  const displayValues = useMemo(() => {
    // Rich controls may coordinate parameters that are intentionally not
    // represented as individual visible controls (for example curve arrays).
    const result: Record<string, unknown> = { ...values };
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

  // A titleless group renders no header row at all, so a group whose controls all
  // render nothing (an empty extension zone) collapses instead of leaving chrome.
  const showHeader =
    (!hideTitle && Boolean(group.title)) || headerActions || keyframe?.enabled;

  return (
    <Box>
      {showHeader ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 1,
            gap: 1,
          }}
        >
          {hideTitle ? (
            <Box />
          ) : (
            <Typography
              variant="caption"
              sx={{
                color: disabled ? "text.disabled" : "text.secondary",
                display: "block",
              }}
            >
              {group.title}
            </Typography>
          )}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {headerActions}
            {keyframe?.enabled ? (
              <IconButton
                size="small"
                onClick={keyframe.onToggle}
                disabled={keyframe.disabled}
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
                    boxShadow: keyframe.active
                      ? "0 0 4px rgba(0,0,0,0.5)"
                      : "none",
                    opacity: keyframe.disabled ? 0.45 : 1,
                  })}
                />
              </IconButton>
            ) : null}
          </Box>
        </Box>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns:
            typeof group.columns === "string"
              ? group.columns
              : `repeat(${group.columns || 1}, 1fr)`,
          gap: 1,
          alignItems: "center",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {group.controls.filter((control) => !control.hidden).map((control) => (
          <React.Fragment key={control.name}>
            {renderControl({
              control,
              value: displayValues[control.name],
              values: displayValues,
              onCommit: (val: unknown) => onCommit(group.id, control.name, val),
              onCommitMany: (nextValues) => {
                if (onCommitMany) {
                  onCommitMany(group.id, nextValues);
                  return;
                }
                Object.entries(nextValues).forEach(([name, nextValue]) => {
                  onCommit(group.id, name, nextValue);
                });
              },
              groupId: group.id,
              disabled,
            })}
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
});
