import { memo } from "react";
import { Box, Tab, Tabs } from "@mui/material";
import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";

export type LeftSidebarTab = "assets";

interface LeftSidebarPanelProps {
  activeTab: LeftSidebarTab;
  onTabChange: (tab: LeftSidebarTab) => void;
}

function LeftSidebarPanelComponent({
  activeTab,
  onTabChange,
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
        onChange={(_, value: LeftSidebarTab) => onTabChange(value)}
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
          sx={{
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
          }}
        />
      </Tabs>
    </Box>
  );
}

export const LeftSidebarPanel = memo(LeftSidebarPanelComponent);
