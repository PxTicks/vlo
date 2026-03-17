import { Box, TextField, IconButton, Typography } from "@mui/material";
import { Casino } from "@mui/icons-material";
import { memo } from "react";
import type { WorkflowWidgetInput } from "../types";

interface WidgetInputsProps {
  widgets: WorkflowWidgetInput[];
  widgetValues: Record<string, Record<string, unknown>>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
}

function widgetKey(nodeId: string, param: string): string {
  return `${nodeId}:${param}`;
}

function isUnsafeIntegerString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  try {
    const intValue = BigInt(trimmed);
    return (
      intValue > BigInt(Number.MAX_SAFE_INTEGER) ||
      intValue < BigInt(Number.MIN_SAFE_INTEGER)
    );
  } catch {
    return false;
  }
}

function shouldUseNumericWidgetInput(
  widget: WorkflowWidgetInput,
  value: unknown,
): boolean {
  const hasNumericType =
    typeof widget.currentValue === "number" || typeof value === "number";
  if (!hasNumericType) return false;

  const hasUnsafeBounds =
    (typeof widget.config.min === "number" &&
      Number.isInteger(widget.config.min) &&
      !Number.isSafeInteger(widget.config.min)) ||
    (typeof widget.config.max === "number" &&
      Number.isInteger(widget.config.max) &&
      !Number.isSafeInteger(widget.config.max));
  if (hasUnsafeBounds) return false;

  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    return false;
  }
  if (typeof value === "string" && isUnsafeIntegerString(value)) {
    return false;
  }
  return true;
}

function parseWidgetValue(raw: string, useNumericInput: boolean): unknown {
  if (!useNumericInput) return raw;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;

  if (/^-?\d+$/.test(trimmed)) {
    if (isUnsafeIntegerString(trimmed)) {
      return trimmed;
    }
    const intValue = Number.parseInt(trimmed, 10);
    return Number.isNaN(intValue) ? raw : intValue;
  }

  const floatValue = Number.parseFloat(trimmed);
  return Number.isNaN(floatValue) ? raw : floatValue;
}

function WidgetRow({
  widget,
  value,
  isRandomized,
  onChange,
  onToggleRandomize,
}: {
  widget: WorkflowWidgetInput;
  value: unknown;
  isRandomized: boolean;
  onChange: (value: unknown) => void;
  onToggleRandomize: () => void;
}) {
  const useNumericInput = shouldUseNumericWidgetInput(widget, value);
  const displayValue =
    value === undefined || value === null
      ? isRandomized
        ? "randomized"
        : ""
      : String(value);

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        mb: 0.5,
      }}
    >
      <Box sx={{ minWidth: 70, flexShrink: 0 }}>
        {widget.config.nodeTitle && (
          <Typography
            variant="caption"
            sx={{
              color: "text.disabled",
              fontSize: "0.6rem",
              display: "block",
              lineHeight: 1.2,
            }}
          >
            {widget.config.nodeTitle}
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontSize: "0.7rem",
            display: "block",
            lineHeight: 1.2,
          }}
        >
          {widget.config.label}
        </Typography>
      </Box>
      <TextField
        size="small"
        type={useNumericInput && !isRandomized ? "number" : "text"}
        value={displayValue}
        disabled={isRandomized}
        onChange={(e) => {
          onChange(parseWidgetValue(e.target.value, useNumericInput));
        }}
        inputProps={{
          ...(useNumericInput && !isRandomized
            ? {
                min: widget.config.min,
                max: widget.config.max,
                step:
                  typeof value === "number" && Number.isInteger(value)
                    ? 1
                    : 0.01,
              }
            : {}),
        }}
        sx={{
          flex: 1,
          "& .MuiOutlinedInput-root": {
            bgcolor: isRandomized ? "#2a2a30" : "#1a1a1a",
            fontSize: "0.75rem",
          },
          "& .MuiOutlinedInput-input": {
            py: 0.5,
            px: 1,
          },
        }}
      />
      {widget.config.controlAfterGenerate && (
        <IconButton
          size="small"
          onClick={onToggleRandomize}
          title={isRandomized ? "Disable randomize" : "Enable randomize"}
          sx={{
            color: isRandomized ? "primary.main" : "text.disabled",
            bgcolor: isRandomized ? "rgba(144,202,249,0.12)" : "transparent",
            borderRadius: 1,
            p: 0.4,
            "&:hover": {
              bgcolor: isRandomized
                ? "rgba(144,202,249,0.2)"
                : "rgba(255,255,255,0.08)",
            },
          }}
        >
          <Casino sx={{ fontSize: 16 }} />
        </IconButton>
      )}
    </Box>
  );
}

const MemoizedWidgetRow = memo(WidgetRow);

export function WidgetInputs({
  widgets,
  widgetValues,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
}: WidgetInputsProps) {
  if (widgets.length === 0) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", px: 2, pb: 1 }}>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", fontWeight: 600, mb: 0.5 }}
      >
        Widget Overrides
      </Typography>
      {widgets.map((widget) => {
        const key = widgetKey(widget.nodeId, widget.param);
        const nodeValues = widgetValues[widget.nodeId] ?? {};
        const value = nodeValues[widget.param] ?? widget.currentValue;
        const isRandomized = randomizeToggles[key] ?? false;

        return (
          <MemoizedWidgetRow
            key={key}
            widget={widget}
            value={value}
            isRandomized={isRandomized}
            onChange={(v) => onWidgetChange(widget.nodeId, widget.param, v)}
            onToggleRandomize={() =>
              onToggleRandomize(widget.nodeId, widget.param)
            }
          />
        );
      })}
    </Box>
  );
}
