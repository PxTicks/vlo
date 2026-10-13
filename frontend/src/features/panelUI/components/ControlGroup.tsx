import React, { memo, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import type {
  ControlCommitOptions,
  LayoutGroup,
  ControlRenderProps,
} from "../types";
import { KeyframeToggleButton } from "./KeyframeToggleButton";

interface ControlGroupProps {
  group: LayoutGroup;
  values: Record<string, unknown>;
  onCommit: (
    groupId: string,
    controlName: string,
    value: unknown,
    options?: ControlCommitOptions,
  ) => void;
  onCommitMany?: (
    groupId: string,
    values: Readonly<Record<string, unknown>>,
    options?: ControlCommitOptions,
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

const CONTROL_GROUP_STACK_BREAKPOINT_PX = 420;

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
  const columnCount =
    typeof group.columns === "number"
      ? Math.max(1, Math.floor(group.columns))
      : null;
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
    <Box sx={{ containerType: "inline-size", minWidth: 0 }}>
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
              <KeyframeToggleButton
                active={keyframe.active}
                onToggle={keyframe.onToggle}
                color={keyframe.color}
                disabled={keyframe.disabled}
              />
            ) : null}
          </Box>
        </Box>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns:
            columnCount === null
              ? group.columns ?? "minmax(0, 1fr)"
              : `repeat(${columnCount}, minmax(0, 1fr))`,
          gap: 1,
          alignItems: "center",
          minWidth: 0,
          opacity: disabled ? 0.5 : 1,
          ...(columnCount !== null && columnCount > 1
            ? {
                [`@container (max-width: ${CONTROL_GROUP_STACK_BREAKPOINT_PX - 1}px)`]: {
                  gridTemplateColumns: "minmax(0, 1fr)",
                },
              }
            : {}),
        }}
      >
        {group.controls.filter((control) => !control.hidden).map((control) => (
          <React.Fragment key={control.name}>
            {renderControl({
              control,
              value: displayValues[control.name],
              values: displayValues,
              onCommit: (val: unknown, options?: ControlCommitOptions) =>
                onCommit(group.id, control.name, val, options),
              onCommitMany: (nextValues, options) => {
                if (onCommitMany) {
                  onCommitMany(group.id, nextValues, options);
                  return;
                }
                Object.entries(nextValues).forEach(([name, nextValue]) => {
                  onCommit(group.id, name, nextValue, options);
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
