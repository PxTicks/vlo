import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { downloadRuntimeDiagnostics } from "../../../services/runtimeApi";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";
import { RuntimeCapabilityCard } from "./RuntimeCapabilityCard";
import { RuntimeEnvironmentCard } from "./RuntimeEnvironmentCard";

/**
 * Runtime & Diagnostics: one card per AI capability plus the backend
 * environment.
 *
 * Deliberately the only surface that pays for deep probes. A cold read runs
 * out-of-process imports and takes several seconds, which is why the panel
 * shows progress rather than an empty list while it waits.
 */
export function RuntimeDiagnosticsPanel() {
  const status = useRuntimeCapabilityStore((state) => state.status);
  const capabilities = useRuntimeCapabilityStore((state) => state.capabilities);
  const environment = useRuntimeCapabilityStore((state) => state.environment);
  const error = useRuntimeCapabilityStore((state) => state.error);
  const refreshing = useRuntimeCapabilityStore((state) => state.refreshing);
  const testing = useRuntimeCapabilityStore((state) => state.testing);
  const ensureLoaded = useRuntimeCapabilityStore((state) => state.ensureLoaded);
  const refreshAll = useRuntimeCapabilityStore((state) => state.refreshAll);
  const refreshCapability = useRuntimeCapabilityStore(
    (state) => state.refreshCapability,
  );
  const testCapability = useRuntimeCapabilityStore(
    (state) => state.testCapability,
  );
  const cancelTests = useRuntimeCapabilityStore((state) => state.cancelTests);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  useEffect(() => () => cancelTests(), [cancelTests]);

  const entries = Object.values(capabilities);
  const busy = status === "checking";

  const copyDiagnostics = () => {
    // Every object carries its own checkedAt, so a support export never
    // implies one moment covers the whole snapshot.
    const payload = JSON.stringify(
      { capabilities: entries, environment },
      null,
      2,
    );
    void navigator.clipboard
      ?.writeText(payload)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const exportDiagnostics = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await downloadRuntimeDiagnostics();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "vlo-runtime-diagnostics.json";
      anchor.click();
      // Firefox and Safari may not begin consuming a detached anchor's object
      // URL until the current task finishes.
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Failed to export diagnostics",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack spacing={1.5} data-testid="runtime-diagnostics-panel">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" sx={{ color: "text.secondary", flex: 1 }}>
          {/* Cards can be rechecked one at a time, so each says when it was
              last checked rather than the panel claiming one time for all. */}
          Runtime diagnostics
        </Typography>
        <Button
          size="small"
          onClick={copyDiagnostics}
          disabled={entries.length === 0}
          sx={{ textTransform: "none" }}
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
        <Button
          size="small"
          onClick={() => void exportDiagnostics()}
          disabled={entries.length === 0 || exporting}
          sx={{ textTransform: "none" }}
        >
          {exporting ? "Exporting…" : "Export diagnostics"}
        </Button>
        <Button
          size="small"
          onClick={() => void refreshAll()}
          disabled={busy}
          sx={{ textTransform: "none" }}
        >
          Recheck all
        </Button>
      </Box>

      {busy ? (
        <Box data-testid="diagnostics-checking">
          <LinearProgress />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Checking runtimes — imports are verified in a separate process, so
            this can take a few seconds.
          </Typography>
        </Box>
      ) : null}

      {error ? <Alert severity="error">{error}</Alert> : null}
      {exportError ? <Alert severity="error">{exportError}</Alert> : null}

      {entries.map((capability) => (
        <RuntimeCapabilityCard
          key={capability.id}
          capability={capability}
          refreshing={refreshing.includes(capability.id)}
          testing={testing.includes(capability.id)}
          onRecheck={(id) => void refreshCapability(id)}
          onTest={(id) => void testCapability(id)}
        />
      ))}

      {environment ? <RuntimeEnvironmentCard environment={environment} /> : null}
    </Stack>
  );
}
