import { useState, memo, useEffect } from "react";
import type { ReactNode } from "react";
import { Box, Tabs, Tab } from "@mui/material";
import {
  useSelectedTimelineClipIds,
  useSelectedTimelineTransitionId,
  useTimelineClip,
} from "../../features/timeline/api";
import {
  EffectsPanel,
  TransformationPanel,
} from "../../features/transformations";
import { GenerationPanel } from "../../features/generation";
import { MaskPanel, useMaskViewStore } from "../../features/masks";
import { TransitionPanel } from "../../features/transitions";
import {
  ExtensionWorkspaceMount,
  useExtensionWorkspaceRegion,
} from "../../features/extensions/ui/publicApi";

type CoreRightSidebarTab =
  | "transform"
  | "effects"
  | "mask"
  | "generate"
  | "transition";

interface TabPanelProps {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly id?: string;
  readonly labelledBy?: string;
  readonly keepMounted?: boolean;
}

function TabPanel({
  active,
  children,
  id,
  labelledBy,
  keepMounted = false,
}: TabPanelProps) {
  return (
    <Box
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
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
      {active || keepMounted ? children : null}
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
  const [activeTab, setActiveTab] = useState<CoreRightSidebarTab>("generate");
  const {
    workspaces,
    selectedWorkspaceId,
    selectWorkspace,
  } = useExtensionWorkspaceRegion("right-sidebar");

  // On selection-kind changes, snap to the matching editor: Transition for a
  // transition, Transform for a clip, and Generate when selection is cleared.
  // A selected extension workspace remains open; the matching core tab is
  // prepared underneath it for when the user returns to a built-in surface.
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
  const visibleCoreTab = hasTransitionSelection
    ? "transition"
    : !hasClipSelection
      ? "generate"
      : isAdjustmentSelected && activeTab === "mask"
        ? "transform"
        : activeTab;
  const visibleTab = selectedWorkspaceId ?? visibleCoreTab;

  useEffect(() => {
    const { setMaskTabActive } = useMaskViewStore.getState();
    setMaskTabActive(visibleTab === "mask");
  }, [visibleTab]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Tabs
        data-testid="right-sidebar-tabs"
        value={visibleTab}
        onChange={(_, value: string) => {
          const workspace = workspaces.find((entry) => entry.id === value);
          if (workspace) {
            selectWorkspace(workspace.id);
            return;
          }
          selectWorkspace(null);
          setActiveTab(value as CoreRightSidebarTab);
        }}
        textColor="primary"
        indicatorColor="primary"
        variant={workspaces.length === 0 ? "fullWidth" : "scrollable"}
        scrollButtons="auto"
        sx={{
          minHeight: 36,
          borderBottom: "1px solid #333",
          "& .MuiTab-root": {
            minWidth: 0,
            minHeight: 36,
            px: 0.75,
            py: 0.5,
            fontSize: "0.72rem",
            lineHeight: 1.2,
            textTransform: "none",
          },
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
            label="Adjust"
            value="transform"
          />
        ) : null}
        {hasClipSelection ? (
          <Tab
            data-testid="right-sidebar-tab-effects"
            label="Transform"
            value="effects"
          />
        ) : null}
        {hasClipSelection && !isAdjustmentSelected && (
          <Tab data-testid="right-sidebar-tab-mask" label="Mask" value="mask" />
        )}
        {workspaces.map((workspace) => (
          <Tab
            key={workspace.id}
            id={`extension-workspace-tab-${workspace.id}`}
            aria-controls={`extension-workspace-panel-${workspace.id}`}
            data-testid={`right-sidebar-tab-${workspace.id}`}
            label={workspace.title}
            value={workspace.id}
          />
        ))}
      </Tabs>
      <Box sx={{ flexGrow: 1, position: "relative", overflow: "hidden" }}>
        <TabPanel active={visibleTab === "generate"} keepMounted>
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
        {hasClipSelection && (
          <TabPanel active={visibleTab === "effects"}>
            <EffectsPanel />
          </TabPanel>
        )}
        {hasClipSelection && !isAdjustmentSelected && (
          <TabPanel active={visibleTab === "mask"}>
            <MaskPanel />
          </TabPanel>
        )}
        {workspaces.map((workspace) => (
          <TabPanel
            key={workspace.id}
            id={`extension-workspace-panel-${workspace.id}`}
            labelledBy={`extension-workspace-tab-${workspace.id}`}
            active={visibleTab === workspace.id}
            keepMounted
          >
            <ExtensionWorkspaceMount
              workspaceId={workspace.id}
              location={workspace.location}
              active={visibleTab === workspace.id}
            />
          </TabPanel>
        ))}
      </Box>
    </Box>
  );
}

export const RightSidebarPanel = memo(RightSidebarPanelComponent);
