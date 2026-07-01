import { memo } from "react";
import { Box, Tab, Tabs, Tooltip } from "@mui/material";
import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";
import TextFieldsIcon from "@mui/icons-material/TextFields";
import LayersIcon from "@mui/icons-material/Layers";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import ExtensionIcon from "@mui/icons-material/Extension";
import type { ExtensionWorkspaceDescriptor } from "../../features/extensions/ui/publicApi";

export type LeftSidebarTab =
  | "assets"
  | "text"
  | "composite"
  | "effects"
  | "transitions";

const TAB_SX = {
  minWidth: 40,
  minHeight: 40,
  width: 40,
  borderRadius: 2,
  color: "#9aa0a6",
  mx: 1,
  my: 0.5,
  "&.Mui-selected": {
    color: "#4dabf5",
    bgcolor: "rgba(77, 171, 245, 0.12)",
  },
} as const;

interface LeftSidebarPanelProps {
  /** A core `LeftSidebarTab` or an extension workspace id. */
  activeTab: string;
  onTabChange: (tab: string) => void;
  workspaces?: readonly ExtensionWorkspaceDescriptor[];
}

function LeftSidebarPanelComponent({
  activeTab,
  onTabChange,
  workspaces = [],
}: LeftSidebarPanelProps) {
  return (
    <Box
      sx={{
        width: 56,
        flexShrink: 0,
        borderRight: "1px solid #333",
        bgcolor: "#0d0d0d",
        display: "flex",
        justifyContent: "center",
        py: 1,
      }}
    >
      <Tabs
        orientation="vertical"
        value={activeTab}
        onChange={(_, value: string) => onTabChange(value)}
        aria-label="Input sources"
        sx={{
          minHeight: 0,
          "& .MuiTabs-indicator": {
            left: 0,
            width: 3,
            borderRadius: "0 999px 999px 0",
          },
        }}
      >
        <Tab
          value="assets"
          icon={<VideoLibraryIcon fontSize="small" />}
          aria-label="Assets"
          data-testid="left-sidebar-tab-assets"
          sx={TAB_SX}
        />
        <Tab
          value="text"
          icon={<TextFieldsIcon fontSize="small" />}
          aria-label="Text"
          data-testid="left-sidebar-tab-text"
          sx={TAB_SX}
        />
        <Tab
          value="composite"
          icon={<LayersIcon fontSize="small" />}
          aria-label="Composite"
          data-testid="left-sidebar-tab-composite"
          sx={TAB_SX}
        />
        <Tab
          value="effects"
          icon={<AutoFixHighIcon fontSize="small" />}
          aria-label="Effects"
          data-testid="left-sidebar-tab-effects"
          sx={TAB_SX}
        />
        <Tab
          value="transitions"
          icon={<CompareArrowsIcon fontSize="small" />}
          aria-label="Transitions"
          data-testid="left-sidebar-tab-transitions"
          sx={TAB_SX}
        />
        {workspaces.map((workspace) => (
          <Tab
            key={workspace.id}
            value={workspace.id}
            id={`extension-workspace-tab-${workspace.id}`}
            aria-controls={`extension-workspace-panel-${workspace.id}`}
            icon={
              <Tooltip title={workspace.title} placement="right">
                <ExtensionIcon fontSize="small" />
              </Tooltip>
            }
            aria-label={workspace.title}
            data-testid={`left-sidebar-tab-${workspace.id}`}
            sx={TAB_SX}
          />
        ))}
      </Tabs>
    </Box>
  );
}

export const LeftSidebarPanel = memo(LeftSidebarPanelComponent);
