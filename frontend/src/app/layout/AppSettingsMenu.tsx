import { useEffect, useMemo, useState } from "react";
import { IconButton, Tooltip } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import ExtensionIcon from "@mui/icons-material/Extension";
import SettingsApplicationsIcon from "@mui/icons-material/SettingsApplications";
import { AppMenu } from "../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../core/shell/menuDescriptors";
import type { HostMenuSubject } from "../../core/shell/hostMenus";
import { getRuntimeSettings } from "../../services/runtimeApi";
import type { WorkflowMode } from "../../types/RuntimeStatus";
import { ExtensionManagerDialog } from "../../features/extensions";
import { RuntimeSettingsDialog } from "./RuntimeSettingsDialog";

const GROUP_LABELS: Readonly<Record<string, string>> = {
  "1_runtime": "RUNTIME",
  "2_extensions": "EXTENSIONS",
};

/**
 * Install-wide settings, hosted on the project landing page.
 *
 * These outlive any single project: workflow mode, the ComfyUI URL and install
 * directory all persist to `app_settings.json` next to the backend, and
 * extensions activate at page load. Project-scoped settings live in the
 * editor's `ProjectSettingsMenu` instead.
 */
export function AppSettingsMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [extensionManagerOpen, setExtensionManagerOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("default");
  const [comfyuiConfigured, setComfyuiConfigured] = useState(false);
  const open = Boolean(anchorEl);

  // Refreshed whenever the menu opens so the subject reflects edits made in the
  // dialog; the landing page has no runtime-status poll of its own.
  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    void getRuntimeSettings({ signal: controller.signal })
      .then((payload) => {
        setWorkflowMode(payload.settings.workflowMode);
        setComfyuiConfigured(Boolean(payload.settings.comfyuiInstallDir));
      })
      .catch(() => {
        // The menu stays usable when the optional local-runtime API is absent.
      });

    return () => controller.abort();
  }, [open]);

  const subject = useMemo<HostMenuSubject<"app.settings">>(
    () => ({
      slot: "app.settings",
      app: { workflowMode, comfyuiConfigured },
    }),
    [workflowMode, comfyuiConfigured],
  );

  const items: HostMenuItemDescriptor[] = [
    {
      kind: "action",
      id: "runtime-settings",
      label: "Runtime settings",
      group: "1_runtime",
      icon: (
        <SettingsApplicationsIcon fontSize="small" sx={{ color: "white" }} />
      ),
      testId: "app-settings-runtime",
      run: () => setRuntimeSettingsOpen(true),
    },
    {
      kind: "action",
      id: "manage-extensions",
      label: "Manage extensions",
      group: "2_extensions",
      icon: <ExtensionIcon fontSize="small" sx={{ color: "white" }} />,
      testId: "app-settings-extensions",
      run: () => setExtensionManagerOpen(true),
    },
  ];

  return (
    <>
      <Tooltip title="App settings">
        <IconButton
          onClick={(event) => setAnchorEl(event.currentTarget)}
          size="small"
          sx={{
            position: "fixed",
            // Sits in the landing page's top gutter, clear of the right
            // panel's identically-iconed "Manage panels" button.
            top: { xs: 9, md: 13 },
            right: { xs: 16, md: 24 },
            zIndex: 10,
            color: "rgba(244, 251, 249, 0.72)",
            "&:hover": { color: "#F4FBF9" },
          }}
          data-testid="app-settings-button"
          aria-label="App Settings"
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <AppMenu
        menuId="app.settings"
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
