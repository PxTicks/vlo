import { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Typography,
} from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type { ModelWorkEntry } from "../services/modelWorkApi";
import {
  selectActiveEntries,
  selectGpuTenant,
  selectHistoryEntries,
  sourceLabel,
  useModelWorkStore,
} from "../useModelWorkStore";

const HISTORY_LIMIT = 12;

const rowSx = {
  p: 1,
  borderRadius: 1,
  border: "1px solid #3a3d44",
  bgcolor: "#2a2d33",
};

const TENANT_LABELS: Record<string, string> = {
  "backend-process": "vlo models",
  "comfyui-process": "ComfyUI",
};

/**
 * `job_status` and `occupancy` are independent by design, so the row states
 * them together rather than inferring one from the other. "Cancelled (still
 * finishing)" is honest: a torch call cannot be interrupted mid-flight.
 */
function statusText(entry: ModelWorkEntry): string {
  if (entry.occupancy === "stopping") return "Cancelled (still finishing)";
  if (entry.occupancy === "waiting") return "Waiting for the GPU";
  if (entry.occupancy === "released") {
    if (entry.jobStatus === "failed") return "Failed";
    if (entry.jobStatus === "cancelled") return "Cancelled";
    return "Done";
  }
  return entry.message ?? "Running";
}

function isMuted(entry: ModelWorkEntry): boolean {
  return entry.occupancy === "stopping" || entry.occupancy === "released";
}

interface ModelWorkRowProps {
  entry: ModelWorkEntry;
  onRelease?: (entry: ModelWorkEntry) => void;
}

function ModelWorkRow({ entry, onRelease }: ModelWorkRowProps) {
  const showProgress =
    entry.occupancy === "occupied" || entry.occupancy === "stopping";
  return (
    <Box sx={{ ...rowSx, opacity: isMuted(entry) ? 0.6 : 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <Chip size="small" label={sourceLabel(entry.source)} />
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {entry.label}
        </Typography>
        {entry.resource === null && (
          <Chip size="small" variant="outlined" label="Not gated" />
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {statusText(entry)}
      </Typography>
      {showProgress && (
        <LinearProgress
          sx={{ mt: 0.5 }}
          variant={entry.progress === null ? "indeterminate" : "determinate"}
          value={entry.progress === null ? undefined : entry.progress * 100}
        />
      )}
      {entry.suspectedStale && onRelease && (
        <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="caption" color="warning.main" sx={{ flex: 1 }}>
            ComfyUI cannot confirm this generation.
          </Typography>
          <Button size="small" color="warning" onClick={() => onRelease(entry)}>
            Force release
          </Button>
        </Box>
      )}
    </Box>
  );
}

export function ModelWorkPanel() {
  // The panel is a reader only. The ledger socket is owned by the editor's
  // orchestration lifecycle, because the generation queue's admission gate
  // depends on it whether or not this tab is open.
  const { ready, connection, error, releaseEntry } = useModelWorkStore(
    useShallow((state) => ({
      ready: state.ready,
      connection: state.connection,
      error: state.error,
      releaseEntry: state.releaseEntry,
    })),
  );
  const active = useModelWorkStore(useShallow(selectActiveEntries));
  const history = useModelWorkStore(useShallow(selectHistoryEntries));
  const tenant = useModelWorkStore(selectGpuTenant);
  const [pendingRelease, setPendingRelease] = useState<ModelWorkEntry | null>(null);

  const confirmRelease = useCallback(async () => {
    if (!pendingRelease) return;
    const entryId = pendingRelease.entryId;
    setPendingRelease(null);
    await releaseEntry(entryId);
  }, [pendingRelease, releaseEntry]);

  return (
    <Box sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle2">GPU</Typography>
        <Typography variant="caption" color="text.secondary">
          {!ready
            ? "Restoring in-flight work…"
            : tenant
              ? `Busy — ${TENANT_LABELS[tenant] ?? tenant}`
              : "Idle"}
        </Typography>
      </Box>

      {connection === "disconnected" && (
        <Alert severity="warning" variant="outlined">
          Disconnected from the backend; reconnecting…
        </Alert>
      )}
      {error && (
        <Alert severity="error" variant="outlined">
          {error}
        </Alert>
      )}

      {active.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          Nothing is running.
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {active.map((entry) => (
            <ModelWorkRow
              key={entry.entryId}
              entry={entry}
              onRelease={setPendingRelease}
            />
          ))}
        </Box>
      )}

      {history.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="subtitle2">Recent</Typography>
          {history.slice(0, HISTORY_LIMIT).map((entry) => (
            <ModelWorkRow key={entry.entryId} entry={entry} />
          ))}
        </Box>
      )}

      <Typography variant="caption" color="text.secondary">
        Model downloads run in their own lane and are never held back by GPU work.
      </Typography>

      <Dialog open={pendingRelease !== null} onClose={() => setPendingRelease(null)}>
        <DialogTitle>Force release the GPU?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            vlo could not confirm with ComfyUI whether this generation is still
            running. Releasing it now lets vlo start its own model work — if the
            generation is in fact still running, both will share the card and may
            run out of memory.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingRelease(null)}>Keep waiting</Button>
          <Button color="warning" onClick={() => void confirmRelease()}>
            Force release
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
