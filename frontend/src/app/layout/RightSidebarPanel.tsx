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
  // Hide the Mask tab when an adjustment clip is the primary selection:
  // adjustment clips bypass `applyClipTransforms`, so neither ClipMask
  // attachments nor range-mask components have any render-time effect.
  const isAdjustmentSelected = useTimelineStore((state) => {
    const id = state.selectedClipIds[0];
    if (!id) return false;
    const clip = state.clips.find((c) => c.id === id);
    return clip?.type === "adjustment";
  });
  const [activeTab, setActiveTab] = useState<RightSidebarTab>("generate");

  useEffect(() => {
    if (!hasSelection && activeTab !== "generate") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("generate");
    }
  }, [activeTab, hasSelection]);

  // Derive visibleTab synchronously so the Tabs `value` never points at a
  // tab that isn't currently rendered: if the user had Mask open and then
  // selected an adjustment clip, we fall through to Transform on the same
  // render rather than via a follow-up effect (which would briefly leave
  // value="mask" without a Mask child, triggering MUI warnings and a
  // spurious setMaskTabActive(true) tick).
  const visibleTab = !hasSelection
    ? "generate"
    : isAdjustmentSelected && activeTab === "mask"
      ? "transform"
      : activeTab;

  useEffect(() => {
    const { setMaskTabActive } = useMaskViewStore.getState();
    setMaskTabActive(visibleTab === "mask");
  }, [visibleTab]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Tabs
        data-testid="right-sidebar-tabs"
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
        <Tab data-testid="right-sidebar-tab-generate" label="Generate" value="generate" />
        {hasSelection && <Tab data-testid="right-sidebar-tab-transform" label="Transform" value="transform" />}
        {hasSelection && !isAdjustmentSelected && (
          <Tab data-testid="right-sidebar-tab-mask" label="Mask" value="mask" />
        )}
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
        {hasSelection && !isAdjustmentSelected && visibleTab === "mask" && (
          <TabPanel active={visibleTab === "mask"}>
            <MaskPanel />
          </TabPanel>
        )}
      </Box>
    </Box>
  );
}

export const RightSidebarPanel = memo(RightSidebarPanelComponent);
