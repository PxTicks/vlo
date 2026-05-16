import { memo, useCallback, useEffect, useState } from "react";
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
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

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
