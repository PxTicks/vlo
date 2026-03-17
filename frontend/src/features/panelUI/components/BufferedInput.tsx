import { useState, useEffect, forwardRef } from "react";
import { TextField, InputAdornment } from "@mui/material";

interface BufferedInputProps {
  label: string;
  value: number;
  onCommit: (val: number) => void;
  step?: number;
  disabled?: boolean;
  variant?: "standard" | "clean";
  endAdornment?: React.ReactNode;
}

/**
 * A text input that buffers edits locally and only calls onCommit on blur/Enter.
 *
 * Accepts a forwarded ref that points to the underlying native <input> element.
 * This allows parent components to imperatively set the displayed value during
 * playback (via liveParamStore) without triggering a React re-render.
 */
export const BufferedInput = forwardRef<HTMLInputElement, BufferedInputProps>(
  function BufferedInput(
    { label, value, onCommit, step, disabled, variant = "standard", endAdornment },
    ref,
  ) {
    const [localValue, setLocalValue] = useState<string>(String(value));

    useEffect(() => {
      setLocalValue(String(value));
    }, [value]);

    const commit = () => {
      if (localValue.trim() === "") {
        setLocalValue(String(value));
        return;
      }
      const num = parseFloat(localValue);
      if (!isNaN(num)) {
        onCommit(num);
      } else {
        setLocalValue(String(value));
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    };

    // Common styles for removing spin buttons
    const noSpinStyles = {
      "& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button": {
        display: "none",
      },
      "& input[type=number]": { MozAppearance: "textfield" }, // Firefox
    };

    if (variant === "clean") {
      return (
        <TextField
          variant="standard"
          size="small"
          type="number"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          slotProps={{
            htmlInput: { step },
            input: { disableUnderline: true } as object,
          }}
          InputProps={{ disableUnderline: true }}
          inputRef={ref}
          sx={{
            ...noSpinStyles,
            "& .MuiInputBase-input": {
              textAlign: "right",
              p: 0,
              fontSize: "0.75rem",
            },
          }}
          fullWidth
          disabled={disabled}
        />
      );
    }

    // Standard (Outlined) Variant
    return (
      <TextField
        label={label}
        variant="outlined"
        size="small"
        type="number"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        slotProps={{ htmlInput: { step } }}
        InputProps={{
          endAdornment: endAdornment ? (
            <InputAdornment position="end">{endAdornment}</InputAdornment>
          ) : null,
        }}
        inputRef={ref}
        sx={noSpinStyles}
        fullWidth
        disabled={disabled}
      />
    );
  },
);
