import { useState, memo, useEffect } from "react";
import type { ReactNode } from "react";
import { Box, Tabs, Tab } from "@mui/material";
import { useTimelineStore } from "../../features/timeline";
import { TransformationPanel } from "../../features/transformations";
import { GenerationPanel } from "../../features/generation";
import { MaskPanel, useMaskViewStore } from "../../features/masks";

type RightSidebarTab = "transform" | "mask" | "generate";

interface TabPanelProps {
  readonly active: boolean;
  readonly children: ReactNode;
}

function TabPanel({ active, children }: TabPanelProps) {
  return (
    <Box
      role="tabpanel"
      aria-hidden={!active}
      sx={{
        position: "absolute",
        inset: 0,
        height: "100%",
        overflowY: "auto",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      {children}
    </Box>
  );
}

function RightSidebarPanelComponent() {
  const hasSelection = useTimelineStore(
    (state) => state.selectedClipIds.length > 0,
  );
  const [activeTab, setActiveTab] = useState<RightSidebarTab>("generate");

  useEffect(() => {
    if (!hasSelection && activeTab !== "generate") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("generate");
    }
  }, [activeTab, hasSelection]);

  const visibleTab = hasSelection ? activeTab : "generate";

  useEffect(() => {
    const { setMaskTabActive } = useMaskViewStore.getState();
    setMaskTabActive(visibleTab === "mask");
  }, [visibleTab]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Tabs
        value={visibleTab}
        onChange={(_, v: RightSidebarTab) => setActiveTab(v)}
        textColor="primary"
        indicatorColor="primary"
        sx={{
          minHeight: 40,
          borderBottom: "1px solid #333",
          "& .MuiTab-root": { minHeight: 40, textTransform: "none" },
        }}
      >
        <Tab label="Generate" value="generate" />
        {hasSelection && <Tab label="Transform" value="transform" />}
        {hasSelection && <Tab label="Mask" value="mask" />}
      </Tabs>
      <Box sx={{ flexGrow: 1, position: "relative", overflow: "hidden" }}>
        <TabPanel active={visibleTab === "generate"}>
          <GenerationPanel />
        </TabPanel>
        {hasSelection && visibleTab === "transform" && (
          <TabPanel active={visibleTab === "transform"}>
            <TransformationPanel />
          </TabPanel>
        )}
        {hasSelection && visibleTab === "mask" && (
          <TabPanel active={visibleTab === "mask"}>
            <MaskPanel />
          </TabPanel>
        )}
      </Box>
    </Box>
  );
}

export const RightSidebarPanel = memo(RightSidebarPanelComponent);
