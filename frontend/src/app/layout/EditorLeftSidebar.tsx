import { useState } from "react";
import { Box } from "@mui/material";
import { AssetBrowser } from "../../features/userAssets";
import { TextPanel } from "../../features/text";
import { CompositePanel } from "../../features/composite";
import { TransformationLibraryPanel } from "../../features/transformations";
import { TransitionLibraryPanel } from "../../features/transitions";
import {
  ExtensionWorkspaceMount,
  useExtensionWorkspaceRegion,
} from "../../features/extensions/ui/publicApi";
import { LeftSidebarPanel } from "./LeftSidebarPanel";
import type { LeftSidebarTab } from "./LeftSidebarPanel";

export function EditorLeftSidebar() {
  const [activeLeftSidebarTab, setActiveLeftSidebarTab] =
    useState<LeftSidebarTab>("assets");
  const { workspaces, selectedWorkspaceId, selectWorkspace } =
    useExtensionWorkspaceRegion("left-sidebar");

  // A selected extension workspace takes precedence; the core tab remains
  // prepared underneath so returning to a built-in surface is instant.
  const visibleTab = selectedWorkspaceId ?? activeLeftSidebarTab;

  const handleTabChange = (value: string) => {
    if (workspaces.some((workspace) => workspace.id === value)) {
      selectWorkspace(value);
      return;
    }
    selectWorkspace(null);
    setActiveLeftSidebarTab(value as LeftSidebarTab);
  };

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
        activeTab={visibleTab}
        onTabChange={handleTabChange}
        workspaces={workspaces}
      />
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          flexGrow: 1,
        }}
      >
        {visibleTab === "assets" ? <AssetBrowser /> : null}
        {visibleTab === "text" ? <TextPanel /> : null}
        {visibleTab === "composite" ? <CompositePanel /> : null}
        {visibleTab === "effects" ? <TransformationLibraryPanel /> : null}
        {visibleTab === "transitions" ? <TransitionLibraryPanel /> : null}
        {workspaces.map((workspace) => (
          <Box
            key={workspace.id}
            id={`extension-workspace-panel-${workspace.id}`}
            role="tabpanel"
            aria-labelledby={`extension-workspace-tab-${workspace.id}`}
            aria-hidden={visibleTab !== workspace.id}
            sx={{
              display: visibleTab === workspace.id ? "flex" : "none",
              flexDirection: "column",
              minWidth: 0,
              flexGrow: 1,
              overflow: "hidden",
            }}
          >
            <ExtensionWorkspaceMount
              workspaceId={workspace.id}
              location="left-sidebar"
              active={visibleTab === workspace.id}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
