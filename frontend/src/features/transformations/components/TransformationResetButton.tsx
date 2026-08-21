import { IconButton, Tooltip } from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";

interface TransformationResetButtonProps {
  /** Accessible label, e.g. "Reset Audio" or "Reset Scale". */
  label: string;
  tooltip?: string;
  onReset: () => void;
}

/**
 * Reset affordance for transformation sections/groups that are always present
 * in the panel. "Reset" returns the controls to their default values by
 * dropping the stored transform (or re-seeding it with defaults) — the section
 * itself stays visible either way.
 */
export function TransformationResetButton({
  label,
  tooltip,
  onReset,
}: TransformationResetButtonProps) {
  return (
    <Tooltip title={tooltip ?? label}>
      <IconButton
        size="small"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onReset();
        }}
        sx={{ p: 0.25, color: "text.secondary" }}
      >
        <RestartAltIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}
