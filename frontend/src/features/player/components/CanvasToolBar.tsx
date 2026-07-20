import type { ReactNode } from "react";
import MousePointerIcon from "@mui/icons-material/Mouse";
import BrushIcon from "@mui/icons-material/Brush";
import { Box, ToggleButton, ToggleButtonGroup, Tooltip } from "@mui/material";
import { canvasToolHost } from "../../../core/shell/canvasToolHost";
import { hostCommandTable } from "../../../core/shell/commandTable";
import { useAvailableCanvasTools } from "../hooks/useCanvasToolHost";

interface CanvasToolBarProps {
  readonly activeToolId: string | null;
}

export function CanvasToolBar({ activeToolId }: CanvasToolBarProps) {
  const tools = useAvailableCanvasTools();
  if (tools.length === 0) return null;

  return (
    <Box
      data-testid="extension-canvas-tool-bar"
      sx={{
        position: "absolute",
        zIndex: 2,
        top: 8,
        left: 8,
        borderRadius: 1,
        bgcolor: "rgba(18, 18, 18, 0.9)",
      }}
    >
      <ToggleButtonGroup
        exclusive
        size="small"
        value={activeToolId ?? "host.default"}
        aria-label="Canvas tools"
      >
        <Tooltip title="Select">
          <ToggleButton
            value="host.default"
            aria-label="Select"
            onClick={() => canvasToolHost.deactivate()}
          >
            <MousePointerIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        {tools.map((tool) => {
          return (
            <Tooltip key={tool.id} title={tool.definition.label}>
              <ToggleButton
                value={tool.id}
                aria-label={tool.definition.label}
                onClick={() =>
                  hostCommandTable.executeCommand(tool.commandId, {
                    source: "toolbar",
                  })
                }
              >
                {(tool.definition.icon?.() as ReactNode) ?? (
                  <BrushIcon fontSize="small" />
                )}
              </ToggleButton>
            </Tooltip>
          );
        })}
      </ToggleButtonGroup>
    </Box>
  );
}
