import { useState } from "react";
import { Box } from "@mui/material";
import { AssetBrowser } from "../../features/userAssets";
import { TextPanel } from "../../features/text";
import { LeftSidebarPanel } from "./LeftSidebarPanel";
import type { LeftSidebarTab } from "./LeftSidebarPanel";

export function EditorLeftSidebar() {
  const [activeLeftSidebarTab, setActiveLeftSidebarTab] =
    useState<LeftSidebarTab>("assets");

  return (
    <Box
      sx={{
        display: "flex",
        minWidth: 0,
        flexGrow: 1,
        height: "100%",
      }}
    >
      <LeftSidebarPanel
        activeTab={activeLeftSidebarTab}
        onTabChange={setActiveLeftSidebarTab}
      />
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          flexGrow: 1,
        }}
      >
        {activeLeftSidebarTab === "assets" ? <AssetBrowser /> : null}
        {activeLeftSidebarTab === "text" ? <TextPanel /> : null}
      </Box>
    </Box>
  );
}
