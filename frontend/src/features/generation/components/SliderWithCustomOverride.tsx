import { Box } from "@mui/material";
import {
  BufferedNumberInput,
  SliderFrame,
  SliderReadoutText,
  SliderTrack,
} from "../../panelUI";

interface SliderMark {
  value: number;
  label: string;
}

interface SliderWithCustomOverrideProps {
  label: string;
  value: number;
  /** The slider's guidance range, not a limit on the value. */
  min: number;
  max: number;
  /** `null` restricts the thumb to `marks`. */
  step: number | null;
  marks?: SliderMark[];
  /** Whether the value is an override rather than a slider stop. */
  isCustom: boolean;
  /** The formatted value, without the custom suffix. */
  readout: string;
  /** The custom field's value, in the units the user types. */
  customValue: string;
  customAriaLabel: string;
  customInputProps?: Record<string, unknown>;
  customEndAdornment?: string;
  /** Parses typed text into a value, or `null` to refuse it. */
  parseCustom: (rawValue: string) => number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/**
 * A slider that offers the common values plus a field for anything else.
 *
 * The slider range is guidance, not a whitelist: the custom field commits any
 * value `parseCustom` accepts, and the readout marks it as custom so an
 * override never looks like a slider stop.
 */
export function SliderWithCustomOverride({
  label,
  value,
  min,
  max,
  step,
  marks,
  isCustom,
  readout,
  customValue,
  customAriaLabel,
  customInputProps,
  customEndAdornment,
  parseCustom,
  onChange,
  disabled,
}: SliderWithCustomOverrideProps) {
  // An override still needs a slider position, so the track stretches to
  // cover it. Clamping the thumb would let a click on it silently replace the
  // override with the edge of the range.
  const trackMin = Math.min(min, value);
  const trackMax = Math.max(max, value);

  return (
    <SliderFrame
      label={label}
      readout={
        <SliderReadoutText>
          {readout}
          {isCustom ? " (custom)" : ""}
        </SliderReadoutText>
      }
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <SliderTrack
            aria-label={label}
            size="small"
            disabled={disabled}
            value={value}
            min={trackMin}
            max={trackMax}
            step={step}
            marks={marks}
            valueLabelDisplay="off"
            onChange={(_, nextValue) => {
              if (typeof nextValue === "number") onChange(nextValue);
            }}
            sx={{
              color: isCustom ? "text.disabled" : "primary.light",
              "& .MuiSlider-markLabel": {
                fontSize: "0.6rem",
                color: "text.disabled",
              },
            }}
          />
        </Box>
        <Box sx={{ flexShrink: 0, width: 92 }}>
          <BufferedNumberInput
            label="Custom"
            disabled={disabled}
            value={customValue}
            endAdornment={customEndAdornment}
            inputProps={{ ...customInputProps, "aria-label": customAriaLabel }}
            onCommit={(rawValue) => {
              const nextValue = parseCustom(rawValue);
              if (nextValue !== null) onChange(nextValue);
            }}
            sx={{
              "& .MuiOutlinedInput-root": {
                bgcolor: "#1a1a1a",
                fontSize: "0.8rem",
              },
            }}
          />
        </Box>
      </Box>
    </SliderFrame>
  );
}
