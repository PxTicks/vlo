import { memo } from "react";
import { styled } from "@mui/material/styles";
import { BufferedInput } from "./BufferedInput";

export interface NumberControlProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  endAdornment?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
  disabled?: boolean;
}

const Root = styled("div")({
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

function NumberControlComponent({
  label,
  value,
  onCommit,
  step,
  endAdornment,
  inputRef,
  disabled,
}: NumberControlProps) {
  return (
    <Root>
      <BufferedInput
        ref={inputRef}
        label={label}
        value={value}
        step={step}
        onCommit={onCommit}
        variant="standard"
        endAdornment={endAdornment}
        disabled={disabled}
      />
    </Root>
  );
}

export const NumberControl = memo(NumberControlComponent);
