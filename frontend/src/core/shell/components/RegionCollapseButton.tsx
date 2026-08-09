import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import { IconButton, Tooltip } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type { ResizableShellRegion } from "../layout/layoutTypes";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";

interface RegionCollapseButtonProps {
  readonly region: ResizableShellRegion;
  readonly label: string;
  readonly testId?: string;
}

/** Persistent keyboard-accessible escape hatch for collapsed shell regions. */
export function RegionCollapseButton({
  region,
  label,
  testId,
}: RegionCollapseButtonProps) {
  const { collapsed, setRegionCollapsed } = useShellLayoutStore(
    useShallow((state) => ({
      collapsed:
        region === "lower-stage"
          ? state.resolved.lowerStage.collapsed
          : state.resolved.regions[region].collapsed,
      setRegionCollapsed: state.setRegionCollapsed,
    })),
  );
  const action = collapsed ? "Expand" : "Collapse";

  return (
    <Tooltip title={`${action} ${label.toLowerCase()}`}>
      <IconButton
        size="small"
        aria-label={`${action} ${label.toLowerCase()}`}
        data-testid={testId}
        onClick={() => setRegionCollapsed(region, !collapsed)}
      >
        {collapsed ? (
          <OpenInFullIcon fontSize="small" />
        ) : (
          <CloseFullscreenIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}
