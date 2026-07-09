import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import type {
  RuntimeSettingsPayload,
  WorkflowMode,
} from "../../types/RuntimeStatus";
import { getRuntimeSettings } from "../../services/runtimeApi";
import { useGenerationStore } from "../../features/generation";

interface RuntimeSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatVram(totalMb: number | null): string {
  if (totalMb === null) return "Unknown";
  return `${Math.round(totalMb / 1024)} GB`;
}

export function RuntimeSettingsDialog({
  open,
  onClose,
}: RuntimeSettingsDialogProps) {
  const updateRuntimeSettings = useGenerationStore(
    (state) => state.updateRuntimeSettings,
  );
  const [payload, setPayload] = useState<RuntimeSettingsPayload | null>(null);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("default");
  const [comfyuiUrl, setComfyuiUrl] = useState("");
  const [comfyuiInstallDir, setComfyuiInstallDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    void getRuntimeSettings({ signal: controller.signal })
      .then((nextPayload) => {
        setPayload(nextPayload);
        setWorkflowMode(nextPayload.settings.workflowMode);
        setComfyuiUrl(nextPayload.settings.comfyuiUrl);
        setComfyuiInstallDir(nextPayload.settings.comfyuiInstallDir ?? "");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Failed to load runtime settings",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateRuntimeSettings({
        workflowMode,
        comfyuiUrl,
        comfyuiInstallDir: comfyuiInstallDir.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save runtime settings",
      );
    } finally {
      setSaving(false);
    }
  };

  const vram = payload?.hardware.vram ?? null;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Runtime Settings</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <FormControl fullWidth size="small" disabled={loading || saving}>
            <InputLabel id="workflow-mode-label">Workflow mode</InputLabel>
            <Select
              labelId="workflow-mode-label"
              label="Workflow mode"
              value={workflowMode}
              onChange={(event) =>
                setWorkflowMode(event.target.value as WorkflowMode)
              }
            >
              <MenuItem value="default">Default</MenuItem>
              <MenuItem value="high_vram">High VRAM</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="ComfyUI URL"
            value={comfyuiUrl}
            disabled={loading || saving}
            onChange={(event) => setComfyuiUrl(event.target.value)}
            fullWidth
          />
          <TextField
            size="small"
            label="ComfyUI install directory"
            value={comfyuiInstallDir}
            disabled={loading || saving}
            onChange={(event) => setComfyuiInstallDir(event.target.value)}
            fullWidth
          />
          <Box>
            <Typography variant="caption" color="text.secondary">
              Detected VRAM
            </Typography>
            <Typography variant="body2">
              {formatVram(vram?.totalMb ?? null)}
              {vram?.source ? ` via ${vram.source}` : ""}
            </Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={loading || saving}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
