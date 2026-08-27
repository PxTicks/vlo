import { useEffect } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useBackendRestartStore } from "../useBackendRestartStore";

interface BackendRestartPromptProps {
  /** What was installed, for the sentence explaining why this is here. */
  label: string;
  dense?: boolean;
}

/**
 * "Installed — now restart", and the restart itself.
 *
 * The prompt is the point: the packages are on disk, and the process serving
 * this page resolved its imports before they were. Whether the button appears
 * is the backend's answer, not a guess — a container, a service under a
 * supervisor, or a frozen build cannot re-exec, and saying so beats offering a
 * button that does nothing.
 *
 * The page reloads itself once a new process answers, because the frontend
 * holds capability state this restart has just invalidated.
 */
export function BackendRestartPrompt({
  label,
  dense = false,
}: BackendRestartPromptProps) {
  const status = useBackendRestartStore((state) => state.status);
  const lifecycle = useBackendRestartStore((state) => state.lifecycle);
  const error = useBackendRestartStore((state) => state.error);
  const refresh = useBackendRestartStore((state) => state.refresh);
  const restart = useBackendRestartStore((state) => state.restart);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = status === "requesting" || status === "waiting";
  const supported = lifecycle?.restartSupported ?? false;
  const blocked = lifecycle?.blockedReason ?? null;

  const run = async (force: boolean) => {
    const restarted = await restart({ force });
    if (restarted) {
      // Everything this page knows about the runtime came from the process
      // that no longer exists.
      globalThis.location.reload();
    }
  };

  return (
    <Alert
      severity="success"
      data-testid="backend-restart-prompt"
      sx={{ py: dense ? 0.25 : undefined }}
    >
      <Typography variant="body2">
        {label} is installed. Restart vlo to finish — the running backend
        loaded its Python packages before this install.
      </Typography>

      {status === "restarted" ? (
        <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
          The backend is back. Reloading…
        </Typography>
      ) : null}

      {blocked && !busy ? (
        <Typography
          variant="caption"
          sx={{ color: "warning.main", display: "block", mt: 0.5 }}
          data-testid="restart-blocked-reason"
        >
          {blocked}
        </Typography>
      ) : null}

      {error ? (
        <Typography
          variant="caption"
          sx={{ color: "error.main", display: "block", mt: 0.5 }}
          data-testid="restart-error"
        >
          {error}
        </Typography>
      ) : null}

      {supported ? (
        <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} alignItems="center">
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={() => void run(false)}
            data-testid="restart-backend"
            sx={{ textTransform: "none" }}
          >
            {busy ? "Restarting…" : "Restart vlo"}
          </Button>
          {busy ? <CircularProgress size={16} /> : null}
          {blocked && !busy ? (
            // Offered only once the user has been told what it costs.
            <Button
              size="small"
              color="warning"
              onClick={() => void run(true)}
              data-testid="restart-backend-force"
              sx={{ textTransform: "none" }}
            >
              Restart anyway
            </Button>
          ) : null}
        </Stack>
      ) : (
        <Box sx={{ mt: 0.75 }}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary" }}
            data-testid="restart-unsupported"
          >
            {/* The backend's own reason where it has one: "cannot restart
                itself" is unhelpful to a developer whose dev server could
                restart perfectly well if they did it themselves. */}
            {lifecycle?.restartUnsupportedReason ??
              "This backend cannot restart itself."}{" "}
            Stop it and start it again — on a managed deployment, restart the
            service.
          </Typography>
        </Box>
      )}
    </Alert>
  );
}
