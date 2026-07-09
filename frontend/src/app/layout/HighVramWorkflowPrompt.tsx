import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import { useGenerationStore } from "../../features/generation";

function formatVram(totalMb: number | null | undefined): string {
  if (typeof totalMb !== "number") return "48 GB or more";
  return `${Math.round(totalMb / 1024)} GB`;
}

export function HighVramWorkflowPrompt() {
  const runtimeStatus = useGenerationStore((state) => state.runtimeStatus);
  const updateRuntimeSettings = useGenerationStore(
    (state) => state.updateRuntimeSettings,
  );
  const [busy, setBusy] = useState(false);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldPrompt =
    runtimeStatus?.recommendations?.shouldPromptForHighVram === true &&
    !dismissedThisSession;

  const handleAccept = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRuntimeSettings({
        workflowMode: "high_vram",
        highVramPromptStatus: "accepted",
      });
      setDismissedThisSession(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to enable high VRAM mode",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRuntimeSettings({ highVramPromptStatus: "declined" });
      setDismissedThisSession(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save high VRAM choice",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={shouldPrompt} onClose={() => void handleDecline()}>
      <DialogTitle>Use High VRAM Workflows?</DialogTitle>
      <DialogContent>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : null}
        <Typography variant="body2">
          This machine reports {formatVram(runtimeStatus?.hardware?.vram.totalMb)}
          {" "}of VRAM. High VRAM workflows use larger precision models where
          available.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void handleDecline()} disabled={busy}>
          Not now
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleAccept()}
          disabled={busy}
        >
          Use High VRAM
        </Button>
      </DialogActions>
    </Dialog>
  );
}
