import { memo } from "react";
import { Slider } from "@mui/material";
import { styled } from "@mui/material/styles";
import { BufferedInput } from "./BufferedInput";

export interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (event: Event, value: number | number[]) => void;
  onChangeCommitted: (
    event: Event | React.SyntheticEvent | unknown,
    value: number | number[],
  ) => void;
  onInputCommit: (value: number) => void;
  endAdornment?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
  sliderRef?: React.Ref<HTMLSpanElement>;
  onMouseDown?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseUp?: React.MouseEventHandler<HTMLSpanElement>;
  disabled?: boolean;
}

const Root = styled("div")({
  display: "flex",
  flexDirection: "column",
  width: "100%",
  paddingLeft: 8,
  paddingRight: 8,
});

const Header = styled("div")({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 4,
});

const Label = styled("div")(({ theme }) => ({
  ...theme.typography.caption,
  color: theme.palette.text.secondary,
}));

const Controls = styled("div")({
  display: "flex",
  alignItems: "center",
  gap: 4,
});

const InputShell = styled("div")({
  width: 60,
});

const StyledSlider = styled(Slider)({
  paddingTop: 4,
  paddingBottom: 4,
});

function SliderControlComponent({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onChangeCommitted,
  onInputCommit,
  endAdornment,
  inputRef,
  sliderRef,
  onMouseDown,
  onMouseUp,
  disabled,
}: SliderControlProps) {
  return (
    <Root>
      <Header>
        <Label>{label}</Label>
        <Controls>
          <InputShell>
            <BufferedInput
              ref={inputRef}
              label=""
              value={value}
              onCommit={onInputCommit}
              step={step}
              variant="clean"
              disabled={disabled}
            />
          </InputShell>
          {endAdornment}
        </Controls>
      </Header>
      <StyledSlider
        ref={sliderRef}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        onChangeCommitted={onChangeCommitted}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        size="small"
        disabled={disabled}
      />
    </Root>
  );
}

export const SliderControl = memo(SliderControlComponent);
