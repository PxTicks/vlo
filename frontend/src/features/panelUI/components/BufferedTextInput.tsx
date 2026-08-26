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
  onPreview?: (val: string) => void;
  onEditEnd?: () => void;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  maxRows?: number;
  endAdornment?: React.ReactNode;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
  inputProps?: Record<string, unknown>;
  commitComparison?: CommitComparisonMode;
  /**
   * When set, typing commits on its own after this idle delay instead of
   * waiting for blur. Gated controls (e.g. a Generate button that reads the
   * committed value) would otherwise stay disabled while the user is still in
   * the field, with no blur to un-stick them — a disabled button never takes
   * focus, so clicking it does not commit either.
   */
  commitDebounceMs?: number;
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
  onPreview,
  onEditEnd,
  disabled,
  placeholder,
  multiline,
  minRows,
  maxRows,
  endAdornment,
  type,
  inputProps,
  commitComparison = "prop",
  commitDebounceMs,
  sx,
}: TextInputProps) {
  const [localValue, setLocalValue] = useState<string>(value);
  const lastCommittedValueRef = useRef(value);
  const localValueRef = useRef(value);
  const valuePropRef = useRef(value);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingCommit = () => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  useEffect(() => {
    valuePropRef.current = value;
    // A debounced commit echoes back as a prop change. Resetting on that echo
    // would discard whatever the user typed while it was in flight, so only an
    // upstream value we did not just commit takes the field over.
    if (value === lastCommittedValueRef.current) {
      return;
    }
    cancelPendingCommit();
    localValueRef.current = value;
    lastCommittedValueRef.current = value;
    // The buffered input must reset when the upstream committed value changes.
    setLocalValue(value);
  }, [value]);

  useEffect(() => cancelPendingCommit, []);

  const commitValue = (nextValue: string) => {
    const comparisonValue =
      commitComparison === "lastCommitted"
        ? lastCommittedValueRef.current
        : valuePropRef.current;
    if (nextValue !== comparisonValue) {
      lastCommittedValueRef.current = nextValue;
      onCommit(nextValue);
    }
  };

  const commit = () => {
    cancelPendingCommit();
    commitValue(localValueRef.current);
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
      onChange={(e) => {
        const nextValue = e.target.value;
        setLocalValue(nextValue);
        localValueRef.current = nextValue;
        onPreview?.(nextValue);
        if (commitDebounceMs === undefined) {
          return;
        }
        cancelPendingCommit();
        commitTimerRef.current = setTimeout(() => {
          commitTimerRef.current = null;
          commitValue(localValueRef.current);
        }, commitDebounceMs);
      }}
      onBlur={() => {
        commit();
        onEditEnd?.();
      }}
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
