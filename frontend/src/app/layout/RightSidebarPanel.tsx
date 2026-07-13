import { useState, memo, useEffect } from "react";
import type { ReactNode } from "react";
import {
  Box,
  IconButton,
  Menu,
  MenuItem,
  Tab,
  Tabs,
  Tooltip,
} from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
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
  readonly label?: string;
  readonly labelledBy?: string;
  readonly keepMounted?: boolean;
}

function TabPanel({
  active,
  children,
  id,
  label,
  labelledBy,
  keepMounted = false,
}: TabPanelProps) {
  return (
    <Box
      id={id}
      role="tabpanel"
      aria-label={label}
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
  const [workspaceMenuAnchor, setWorkspaceMenuAnchor] =
    useState<HTMLElement | null>(null);
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
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );

  useEffect(() => {
    const { setMaskTabActive } = useMaskViewStore.getState();
    setMaskTabActive(visibleTab === "mask");
  }, [visibleTab]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid #333",
        }}
      >
        <Tabs
          data-testid="right-sidebar-tabs"
          value={selectedWorkspaceId === null ? visibleCoreTab : false}
          onChange={(_, value: CoreRightSidebarTab) => {
            selectWorkspace(null);
            setActiveTab(value);
          }}
          textColor="primary"
          indicatorColor="primary"
          variant="fullWidth"
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 36,
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
            <Tab
              data-testid="right-sidebar-tab-mask"
              label="Mask"
              value="mask"
            />
          )}
        </Tabs>
        {workspaces.length > 0 ? (
          <>
            <Tooltip title={selectedWorkspace?.title ?? "More panels"}>
              <IconButton
                data-testid="right-sidebar-workspace-menu-button"
                aria-label="More panels"
                aria-haspopup="menu"
                aria-expanded={workspaceMenuAnchor !== null}
                aria-controls={
                  workspaceMenuAnchor === null
                    ? undefined
                    : "right-sidebar-workspace-menu"
                }
                aria-pressed={selectedWorkspaceId !== null}
                size="small"
                onClick={(event) => setWorkspaceMenuAnchor(event.currentTarget)}
                sx={{
                  width: 32,
                  minHeight: 36,
                  flexShrink: 0,
                  borderLeft: "1px solid #333",
                  borderRadius: 0,
                  color:
                    selectedWorkspaceId === null
                      ? "text.secondary"
                      : "primary.main",
                  bgcolor:
                    selectedWorkspaceId === null
                      ? "transparent"
                      : "action.selected",
                }}
              >
                <ArrowDropDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              id="right-sidebar-workspace-menu"
              anchorEl={workspaceMenuAnchor}
              open={workspaceMenuAnchor !== null}
              onClose={() => setWorkspaceMenuAnchor(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
              transformOrigin={{ vertical: "top", horizontal: "right" }}
              slotProps={{ paper: { sx: { maxHeight: 320 } } }}
            >
              {workspaces.map((workspace) => (
                <MenuItem
                  key={workspace.id}
                  data-testid={`right-sidebar-workspace-menu-item-${workspace.id}`}
                  selected={workspace.id === selectedWorkspaceId}
                  onClick={() => {
                    selectWorkspace(workspace.id);
                    setWorkspaceMenuAnchor(null);
                  }}
                >
                  {workspace.title}
                </MenuItem>
              ))}
            </Menu>
          </>
        ) : null}
      </Box>
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
            label={workspace.title}
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
