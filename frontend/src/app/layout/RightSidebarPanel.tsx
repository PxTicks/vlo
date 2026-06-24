import { useState, memo, useEffect } from "react";
import type { ReactNode } from "react";
import { Box, Tabs, Tab } from "@mui/material";
import {
  useSelectedTimelineClipIds,
  useSelectedTimelineTransitionId,
  useTimelineClip,
} from "../../features/timeline/api";
import { TransformationPanel } from "../../features/transformations";
import { GenerationPanel } from "../../features/generation";
import { MaskPanel, useMaskViewStore } from "../../features/masks";
import { TransitionPanel } from "../../features/transitions";

type RightSidebarTab = "transform" | "mask" | "generate" | "transition";

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
  const selectedClipIds = useSelectedTimelineClipIds();
  const selectedTransitionId = useSelectedTimelineTransitionId();
  const hasTransitionSelection = selectedTransitionId !== null;
  const hasClipSelection = selectedClipIds.length > 0;
  const hasSelection = hasClipSelection || hasTransitionSelection;
  // Hide the Mask tab when an adjustment clip is the primary selection:
  // adjustment clips bypass `applyClipTransforms`, so neither ClipMask
  // attachments nor range-mask components have any render-time effect.
  const primarySelectedClip = useTimelineClip(selectedClipIds[0]);
  const isAdjustmentSelected = primarySelectedClip?.type === "adjustment";
  const [activeTab, setActiveTab] = useState<RightSidebarTab>("generate");

  // On selection-kind changes, snap to the matching editor: Transition for a
  // transition, Transform for a clip, and Generate when selection is cleared.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(
      hasTransitionSelection
        ? "transition"
        : hasSelection
          ? "transform"
          : "generate",
    );
  }, [hasSelection, hasTransitionSelection]);

  // Derive visibleTab synchronously so the Tabs `value` never points at a
  // tab that isn't currently rendered: if the user had Mask open and then
  // selected an adjustment clip, we fall through to Transform on the same
  // render rather than via a follow-up effect (which would briefly leave
  // value="mask" without a Mask child, triggering MUI warnings and a
  // spurious setMaskTabActive(true) tick).
  const visibleTab = hasTransitionSelection
    ? "transition"
    : !hasClipSelection
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
        <Tab
          data-testid="right-sidebar-tab-generate"
          label="Generate"
          value="generate"
        />
        {hasTransitionSelection ? (
          <Tab
            data-testid="right-sidebar-tab-transition"
            label="Transition"
            value="transition"
          />
        ) : null}
        {hasClipSelection ? (
          <Tab
            data-testid="right-sidebar-tab-transform"
            label="Transform"
            value="transform"
          />
        ) : null}
        {hasClipSelection && !isAdjustmentSelected && (
          <Tab data-testid="right-sidebar-tab-mask" label="Mask" value="mask" />
        )}
      </Tabs>
      <Box sx={{ flexGrow: 1, position: "relative", overflow: "hidden" }}>
        <TabPanel active={visibleTab === "generate"}>
          <GenerationPanel />
        </TabPanel>
        {hasTransitionSelection && (
          <TabPanel active={visibleTab === "transition"}>
            <TransitionPanel />
          </TabPanel>
        )}
        {hasClipSelection && (
          <TabPanel active={visibleTab === "transform"}>
            <TransformationPanel />
          </TabPanel>
        )}
        {hasClipSelection && !isAdjustmentSelected && (
          <TabPanel active={visibleTab === "mask"}>
            <MaskPanel />
          </TabPanel>
        )}
      </Box>
    </Box>
  );
}

export const RightSidebarPanel = memo(RightSidebarPanelComponent);
