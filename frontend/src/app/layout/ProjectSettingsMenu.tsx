import { useMemo, useState } from "react";
import { IconButton } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import ViewSidebarIcon from "@mui/icons-material/ViewSidebar";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import BugReportIcon from "@mui/icons-material/BugReport";
import ExtensionIcon from "@mui/icons-material/Extension";
import SettingsApplicationsIcon from "@mui/icons-material/SettingsApplications";
import { AppMenu } from "../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../core/shell/menuDescriptors";
import type { HostMenuSubject } from "../../core/shell/hostMenus";
import type {
  AspectRatio,
  AssetBrowserDisplay,
  ProjectFitMode,
} from "../../features/project";
import { useProjectStore } from "../../features/project/useProjectStore";
import { useDebugStore } from "../../shared/debug/useDebugStore";
import { ExtensionManagerDialog } from "../../features/extensions";
import { RuntimeSettingsDialog } from "./RuntimeSettingsDialog";

const FPS_OPTIONS = [16, 24, 25, 30, 60];

const FIT_MODE_OPTIONS: Array<{ value: ProjectFitMode; label: string }> = [
  { value: "contain", label: "Contain (Letterbox)" },
  { value: "cover", label: "Cover (Fill & Crop)" },
];

const ASPECT_RATIO_OPTIONS: Array<{ value: AspectRatio; label: string }> = [
  { value: "16:9", label: "16:9 (Landscape)" },
  { value: "4:3", label: "4:3 (Standard)" },
  { value: "1:1", label: "1:1 (Square)" },
  { value: "3:4", label: "3:4 (Portrait)" },
  { value: "9:16", label: "9:16 (Story)" },
];

const GROUP_LABELS: Readonly<Record<string, string>> = {
  "1_layout": "LAYOUT",
  "2_fps": "FPS",
  "3_aspect": "ASPECT RATIO",
  "4_fit": "FIT MODE",
  "5_browser": "ASSET BROWSER",
  "6_extensions": "EXTENSIONS",
  "7_runtime": "RUNTIME",
  "8_debug": "DEBUG",
};

export function ProjectSettingsMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [extensionManagerOpen, setExtensionManagerOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const open = Boolean(anchorEl);

  const config = useProjectStore((state) => state.config);
  const debugMode = useDebugStore((state) => state.debugMode);
  const toggleDebugMode = useDebugStore((state) => state.toggleDebugMode);

  const currentFitMode = config.fitMode || "contain";
  const currentLayout = config.layoutMode || "compact";
  const currentFps = config.fps || 30;
  const currentAspectRatio = config.aspectRatio || "16:9";
  const currentAssetBrowserDisplay = config.assetBrowserDisplay || "grouped";

  const subject = useMemo<HostMenuSubject<"app.project.settings">>(
    () => ({
      slot: "app.project.settings",
      project: {
        fps: currentFps,
        aspectRatio: currentAspectRatio,
        fitMode: currentFitMode,
        layoutMode: currentLayout,
        assetBrowserDisplay: currentAssetBrowserDisplay,
      },
    }),
    [
      currentFps,
      currentAspectRatio,
      currentFitMode,
      currentLayout,
      currentAssetBrowserDisplay,
    ],
  );

  const items: HostMenuItemDescriptor[] = [
    {
      kind: "command",
      id: "layout-full-height",
      command: "project.set-layout",
      subject: { layoutMode: "full-height" },
      label: "Full Height Sidebars",
      group: "1_layout",
      icon: (
        <ViewSidebarIcon
          fontSize="small"
          sx={{
            color: currentLayout === "full-height" ? "primary.main" : "white",
          }}
        />
      ),
      selected: currentLayout === "full-height",
    },
    {
      kind: "command",
      id: "layout-compact",
      command: "project.set-layout",
      subject: { layoutMode: "compact" },
      label: "Classic (Wide Timeline)",
      group: "1_layout",
      icon: (
        <ViewStreamIcon
          fontSize="small"
          sx={{
            color: currentLayout === "compact" ? "primary.main" : "white",
          }}
        />
      ),
      selected: currentLayout === "compact",
    },
    ...FPS_OPTIONS.map(
      (fps): HostMenuItemDescriptor => ({
        kind: "command",
        id: `fps-${fps}`,
        command: "project.set-fps",
        subject: { fps },
        label: `${fps} fps`,
        group: "2_fps",
        selected: currentFps === fps,
      }),
    ),
    ...ASPECT_RATIO_OPTIONS.map(
      (ratio): HostMenuItemDescriptor => ({
        kind: "command",
        id: `aspect-${ratio.value}`,
        command: "project.set-aspect-ratio",
        subject: { aspectRatio: ratio.value },
        label: ratio.label,
        group: "3_aspect",
        selected: currentAspectRatio === ratio.value,
      }),
    ),
    ...FIT_MODE_OPTIONS.map(
      (option): HostMenuItemDescriptor => ({
        kind: "command",
        id: `fit-${option.value}`,
        command: "project.set-fit-mode",
        subject: { fitMode: option.value },
        label: option.label,
        group: "4_fit",
        selected: currentFitMode === option.value,
      }),
    ),
    {
      kind: "command",
      id: "browser-grouped",
      command: "project.set-asset-browser-display",
      subject: { assetBrowserDisplay: "grouped" satisfies AssetBrowserDisplay },
      label: "Grouped assets",
      group: "5_browser",
      selected: currentAssetBrowserDisplay === "grouped",
    },
    {
      kind: "command",
      id: "browser-ungrouped",
      command: "project.set-asset-browser-display",
      subject: {
        assetBrowserDisplay: "ungrouped" satisfies AssetBrowserDisplay,
      },
      label: "Ungrouped assets",
      group: "5_browser",
      selected: currentAssetBrowserDisplay === "ungrouped",
    },
    {
      kind: "action",
      id: "manage-extensions",
      label: "Manage extensions",
      group: "6_extensions",
      icon: <ExtensionIcon fontSize="small" sx={{ color: "white" }} />,
      testId: "project-settings-extensions",
      run: () => setExtensionManagerOpen(true),
    },
    {
      kind: "action",
      id: "runtime-settings",
      label: "Runtime settings",
      group: "7_runtime",
      icon: (
        <SettingsApplicationsIcon fontSize="small" sx={{ color: "white" }} />
      ),
      testId: "project-settings-runtime",
      run: () => setRuntimeSettingsOpen(true),
    },
    ...(import.meta.env.DEV
      ? [
          {
            kind: "action",
            id: "debug-toggle",
            label: "Debug mode",
            group: "8_debug",
            icon: (
              <BugReportIcon
                fontSize="small"
                sx={{ color: debugMode ? "primary.main" : "white" }}
              />
            ),
            selected: debugMode,
            testId: "project-settings-debug-toggle",
            run: toggleDebugMode,
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
  ];

  return (
    <>
      <IconButton
        onClick={(event) => setAnchorEl(event.currentTarget)}
        size="small"
        sx={{ ml: 1, color: "rgba(255, 255, 255, 0.7)" }}
        data-testid="project-settings-button"
        aria-label="Project Settings"
      >
        <SettingsIcon fontSize="small" />
      </IconButton>
      <AppMenu
        menuId="app.project.settings"
        subject={subject}
        items={items}
        groupLabels={GROUP_LABELS}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorEl={anchorEl}
        slotProps={{
          paper: {
            sx: {
              bgcolor: "#1e1e1e",
              color: "white",
              border: "1px solid #333",
              minWidth: 200,
            },
          },
        }}
      />
      <ExtensionManagerDialog
        open={extensionManagerOpen}
        onClose={() => setExtensionManagerOpen(false)}
      />
      <RuntimeSettingsDialog
        open={runtimeSettingsOpen}
        onClose={() => setRuntimeSettingsOpen(false)}
      />
    </>
  );
}
