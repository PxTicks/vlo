import { memo, useEffect, useRef, useState } from "react";
import {
  TextField,
  InputAdornment,
  type SxProps,
  type Theme,
} from "@mui/material";

type CommitComparisonMode = "prop" | "lastCommitted";

interface BaseTextInputProps {
  label?: string;
  value: string;
  onCommit: (val: string) => void;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  maxRows?: number;
  endAdornment?: React.ReactNode;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
  inputProps?: Record<string, unknown>;
  commitComparison?: CommitComparisonMode;
  sx?: SxProps<Theme>; // To allow custom styling
}

export type TextInputProps = BaseTextInputProps;

export type BufferedTextInputProps = Omit<
  BaseTextInputProps,
  "commitComparison"
>;

export interface CommittedTextInputProps
  extends Omit<BaseTextInputProps, "commitComparison" | "value"> {
  initialValue: string;
}

function TextInputComponent({
  label,
  value,
  onCommit,
  disabled,
  placeholder,
  multiline,
  minRows,
  maxRows,
  endAdornment,
  type,
  inputProps,
  commitComparison = "prop",
  sx,
}: TextInputProps) {
  const [localValue, setLocalValue] = useState<string>(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    // The buffered input must reset when the upstream committed value changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  const commit = () => {
    const comparisonValue =
      commitComparison === "lastCommitted"
        ? lastCommittedValueRef.current
        : value;
    if (localValue !== comparisonValue) {
      if (commitComparison === "lastCommitted") {
        lastCommittedValueRef.current = localValue;
      }
      onCommit(localValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && multiline) {
      // Support Ctrl+Enter to commit for multiline
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <TextField
      label={label}
      variant="outlined"
      size="small"
      type={type}
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      multiline={multiline}
      minRows={minRows}
      maxRows={maxRows}
      InputProps={{
        endAdornment: endAdornment ? (
          <InputAdornment position="end">{endAdornment}</InputAdornment>
        ) : null,
      }}
      inputProps={inputProps}
      sx={sx}
      fullWidth
      disabled={disabled}
    />
  );
}

export const TextInput = memo(TextInputComponent);

function BufferedTextInputComponent(props: BufferedTextInputProps) {
  return <TextInput {...props} commitComparison="prop" />;
}

function CommittedTextInputComponent({
  initialValue,
  ...props
}: CommittedTextInputProps) {
  return (
    <TextInput
      {...props}
      value={initialValue}
      commitComparison="lastCommitted"
    />
  );
}

export const BufferedTextInput = memo(BufferedTextInputComponent);
export const CommittedTextInput = memo(CommittedTextInputComponent);
