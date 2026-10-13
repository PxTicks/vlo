import { Box, IconButton } from "@mui/material";

export interface KeyframeToggleButtonProps {
  active: boolean;
  onToggle: () => void;
  color?: string;
  disabled?: boolean;
}

/** Diamond button that adds or removes a keyframe at the playhead. */
export function KeyframeToggleButton({
  active,
  onToggle,
  color,
  disabled = false,
}: KeyframeToggleButtonProps) {
  return (
    <IconButton
      size="small"
      onClick={onToggle}
      disabled={disabled}
      title={active ? "Keyframe exists at playhead" : "Add keyframe at playhead"}
      sx={{ p: 0.25 }}
    >
      <Box
        sx={(theme) => ({
          width: 8,
          height: 8,
          transform: "rotate(45deg)",
          backgroundColor: active
            ? color ?? theme.palette.secondary.main
            : "transparent",
          border: `1px solid ${color ?? theme.palette.text.secondary}`,
          boxShadow: active ? "0 0 4px rgba(0,0,0,0.5)" : "none",
          opacity: disabled ? 0.45 : 1,
        })}
      />
    </IconButton>
  );
}
