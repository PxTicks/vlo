import { SliderWithCustomOverride } from "./SliderWithCustomOverride";

interface MaskCropPaddingControlProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function parsePaddingPercentage(rawValue: string): number | null {
  if (!rawValue.trim()) return null;
  const percentage = Number(rawValue);
  if (!Number.isFinite(percentage) || percentage < 0) return null;
  return percentage / 100;
}

export function MaskCropPaddingControl({
  label,
  value,
  onChange,
  disabled,
}: MaskCropPaddingControlProps) {
  const percentage = Number((value * 100).toFixed(2));

  return (
    <SliderWithCustomOverride
      label={label}
      value={value}
      min={0}
      max={1}
      step={0.01}
      isCustom={value > 1}
      readout={`${percentage}%`}
      customValue={String(percentage)}
      customAriaLabel="Custom crop padding"
      customInputProps={{ min: 0, step: 1 }}
      customEndAdornment="%"
      parseCustom={parsePaddingPercentage}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
