import { memo } from "react";
import { Box, Tab, Tabs, Tooltip } from "@mui/material";
import ExtensionIcon from "@mui/icons-material/Extension";
import type { ShellViewEntry } from "../../core/shell/viewRegistry";
import { ViewLayoutButton } from "../../core/shell/ViewLayoutButton";

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
  activeTab: string | null;
  onTabChange: (tab: string) => void;
  views: readonly ShellViewEntry[];
}

function LeftSidebarPanelComponent({
  activeTab,
  onTabChange,
  views,
}: LeftSidebarPanelProps) {
  return (
    <Box
      sx={{
        width: 56,
        flexShrink: 0,
        borderRight: "1px solid #333",
        bgcolor: "#0d0d0d",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        py: 1,
      }}
    >
      <Tabs
        orientation="vertical"
        variant="scrollable"
        scrollButtons="auto"
        value={activeTab ?? false}
        onChange={(_, value: string) => onTabChange(value)}
        aria-label="Input sources"
        sx={{
          minHeight: 0,
          flex: 1,
          minWidth: 0,
          "& .MuiTabs-indicator": {
            left: 0,
            width: 3,
            borderRadius: "0 999px 999px 0",
          },
        }}
      >
        {views.map((view) => (
          <Tab
            key={view.id}
            value={view.id}
            id={`shell-view-tab-${view.id}`}
            aria-controls={`shell-view-panel-${view.id}`}
            icon={
              <Tooltip title={view.title} placement="right">
                <span>
                  {view.icon?.() ?? <ExtensionIcon fontSize="small" />}
                </span>
              </Tooltip>
            }
            aria-label={view.title}
            data-testid={`left-sidebar-tab-${view.id.replace(/^host\./, "")}`}
            sx={TAB_SX}
          />
        ))}
      </Tabs>
      <ViewLayoutButton region="left-sidebar" />
    </Box>
  );
}

export const LeftSidebarPanel = memo(LeftSidebarPanelComponent);
