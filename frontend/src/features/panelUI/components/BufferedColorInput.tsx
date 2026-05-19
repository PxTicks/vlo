import { memo, useCallback, useState } from "react";
import { TextField, type SxProps, type Theme } from "@mui/material";

export interface BufferedColorInputProps {
  value: string;
  onCommit: (value: string) => void;
  onPreview?: (value: string) => void;
  onEditEnd?: () => void;
  label?: string;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

function BufferedColorInputComponent({
  value,
  onCommit,
  onPreview,
  onEditEnd,
  label = "Color",
  disabled,
  sx,
}: BufferedColorInputProps) {
  // Track the upstream value alongside the buffered local value so external
  // changes (undo/redo, programmatic edits) snap into the field without
  // an effect. See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [localValue, setLocalValue] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (committedValue !== value) {
    setCommittedValue(value);
    setLocalValue(value);
  }

  const commit = useCallback(() => {
    if (localValue !== value) {
      onCommit(localValue);
    }
  }, [localValue, onCommit, value]);

  return (
    <TextField
      label={label}
      size="small"
      type="color"
      value={localValue}
      onChange={(event) => {
        const nextValue = event.target.value;
        setLocalValue(nextValue);
        onPreview?.(nextValue);
      }}
      onBlur={() => {
        commit();
        onEditEnd?.();
      }}
      sx={sx}
      disabled={disabled}
    />
  );
}

export const BufferedColorInput = memo(BufferedColorInputComponent);
