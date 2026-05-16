import { memo, useCallback, useEffect, useState } from "react";
import { TextField, type SxProps, type Theme } from "@mui/material";

export interface BufferedColorInputProps {
  value: string;
  onCommit: (value: string) => void;
  label?: string;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

function BufferedColorInputComponent({
  value,
  onCommit,
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
      onChange={(event) => setLocalValue(event.target.value)}
      onBlur={commit}
      sx={sx}
      disabled={disabled}
    />
  );
}

export const BufferedColorInput = memo(BufferedColorInputComponent);
