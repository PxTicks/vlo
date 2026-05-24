import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { OpenInNew, WarningAmberOutlined } from "@mui/icons-material";
import {
  getAvailableModels,
  startModelDownload,
  startModelDownloadBatch,
  type DownloadableModel,
} from "../../../services/downloadApi";
import { ModelDownloadPanel } from "../../../shared/components/ModelDownloadPanel";
import { useModelDownloadController } from "../../../shared/hooks/useModelDownloadController";
import type { WorkflowWarningSummary } from "../services/workflowBridge";
import { useGenerationStore } from "../useGenerationStore";

interface WorkflowDependencyResolverProps {
  workflowId: string | null;
  warning: WorkflowWarningSummary;
  onOpenEditor: () => void;
  onRefreshWarning: () => void;
}

const MAX_VISIBLE_ITEMS = 6;
const EXTERNAL_POLL_INTERVAL_MS = 5000;

function normalizeModelName(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return (segments.at(-1) ?? normalized).toLowerCase();
}

function resolveSuggestedModels(
  workflowModels: DownloadableModel[],
  missingModels: string[],
): DownloadableModel[] {
  if (missingModels.length === 0) {
    return [];
  }

  const missingModelNames = new Set(
    missingModels.map((modelName) => normalizeModelName(modelName)),
  );
  const matchingModels = workflowModels.filter((model) =>
    missingModelNames.has(normalizeModelName(model.filename ?? model.label)),
  );

  return matchingModels.length > 0 ? matchingModels : workflowModels;
}

function buildSummary(
  missingModelCount: number,
  missingNodeCount: number,
  hasDownloadOptions: boolean,
): string {
  if (missingModelCount > 0 && missingNodeCount > 0) {
    return hasDownloadOptions
      ? "ComfyUI is missing models and nodes for this workflow. You can try the workflow's download options below, or open the editor to resolve naming and node issues."
      : "ComfyUI is missing models and nodes for this workflow. Open the editor to resolve them in ComfyUI.";
  }

  if (missingModelCount > 0) {
    return hasDownloadOptions
      ? "ComfyUI is missing models for this workflow. You can try the workflow's download options below, or open the editor if the model names differ."
      : "ComfyUI is missing models for this workflow. Open the editor to resolve them in ComfyUI.";
  }

  return "ComfyUI is missing nodes for this workflow. Open the editor to install or fix them.";
}

function renderWarningList(label: string, values: string[]) {
  if (values.length === 0) {
    return null;
  }

  const visibleValues = values.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenCount = Math.max(0, values.length - MAX_VISIBLE_ITEMS);

  return (
    <Box sx={{ textAlign: "left" }}>
      <Typography variant="caption" sx={{ color: "warning.light", display: "block", mb: 0.25 }}>
        {label} ({values.length})
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          lineHeight: 1.5,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {visibleValues.join(", ")}
        {hiddenCount > 0 ? `, and ${hiddenCount} more` : ""}
      </Typography>
    </Box>
  );
}

export function WorkflowDependencyResolver({
  workflowId,
  warning,
  onOpenEditor,
  onRefreshWarning,
}: WorkflowDependencyResolverProps) {
  const [workflowModels, setWorkflowModels] = useState<DownloadableModel[]>([]);
  const [loading, setLoading] = useState(false);
  const workflowModelsRequestIdRef = useRef(0);

  const fetchWorkflowModels = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const requestId = workflowModelsRequestIdRef.current + 1;
      workflowModelsRequestIdRef.current = requestId;

      if (!workflowId || warning.missingModels.length === 0) {
        setWorkflowModels([]);
        setLoading(false);
        return;
      }

      if (!options.silent) {
        setLoading(true);
      }
      try {
        const response = await getAvailableModels({ workflowId });
        if (workflowModelsRequestIdRef.current !== requestId) {
          return;
        }
        setWorkflowModels(response.comfyui?.workflowModels ?? []);
      } catch {
        if (workflowModelsRequestIdRef.current !== requestId) {
          return;
        }
        setWorkflowModels([]);
      } finally {
        if (workflowModelsRequestIdRef.current === requestId && !options.silent) {
          setLoading(false);
        }
      }
    },
    [warning.missingModels.length, workflowId],
  );

  // Fetch-on-mount + refetch-on-dep-change is the documented escape hatch
  // for the react-hooks/set-state-in-effect rule when no data-fetching
  // library is in play. See https://react.dev/reference/react/useEffect#fetching-data-with-effects
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchWorkflowModels();
  }, [fetchWorkflowModels]);

  // Poll silently so this panel reflects downloads started by other workflows.
  useEffect(() => {
    if (!workflowId || warning.missingModels.length === 0) return;
    const interval = globalThis.setInterval(() => {
      void fetchWorkflowModels({ silent: true });
    }, EXTERNAL_POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [fetchWorkflowModels, warning.missingModels.length, workflowId]);

  const modelsToShow = useMemo(
    () => resolveSuggestedModels(workflowModels, warning.missingModels),
    [warning.missingModels, workflowModels],
  );

  const refreshMissingModelsFromIframe = useGenerationStore(
    (state) => state.refreshMissingModelsFromIframe,
  );

  // Ask ComfyUI to re-scan its model folders and re-evaluate pendingWarnings
  // — same path the MissingModelCard "Refresh" button takes. Falls back to a
  // full workflow reload when the iframe call can't execute (no editor ref,
  // or app.refreshMissingModels unavailable).
  const refreshWarningAfterDownloads = useCallback(async () => {
    const refreshed = await refreshMissingModelsFromIframe();
    if (!refreshed) {
      onRefreshWarning();
    }
  }, [onRefreshWarning, refreshMissingModelsFromIframe]);

  const {
    activeDownloads,
    error,
    dismissError,
    anyLocalDownloadActive,
    handleDownload,
    handleCancel,
    handleDownloadAll,
    adoptExternalJob,
  } = useModelDownloadController({
    startDownload: (modelKey, context) =>
      startModelDownload("comfyui-workflow", modelKey, {
        workflowId: workflowId ?? undefined,
        hfToken: context?.hfToken,
      }),
    startBatch: (modelKeys, context) =>
      startModelDownloadBatch("comfyui-workflow", modelKeys, {
        workflowId: workflowId ?? undefined,
        hfToken: context?.hfToken,
      }),
    onDownloadComplete: () => {
      // Refresh model list so the just-downloaded entry flips to "installed"
      // (and drops out of the Download all candidate set). Cheap call.
      void fetchWorkflowModels({ silent: true });
    },
    onAllDownloadsComplete: () => {
      // Independent reads; model list does not gate the iframe refresh.
      void fetchWorkflowModels({ silent: true });
      void refreshWarningAfterDownloads();
    },
  });

  // If we re-mount the resolver and every suggested model is already on
  // disk (a "Download all" finished while the user was on a different
  // workflow, or the user dropped models in manually), the per-job
  // active→empty signal never reached this hook. Trigger the same refresh
  // path so the stale warning clears and the gen tab activates.
  const allSuggestedInstalled =
    modelsToShow.length > 0 && modelsToShow.every((model) => model.installed);
  useEffect(() => {
    if (!allSuggestedInstalled) return;
    void refreshWarningAfterDownloads();
  }, [allSuggestedInstalled, refreshWarningAfterDownloads]);

  return (
    <ModelDownloadPanel
      icon={<WarningAmberOutlined sx={{ fontSize: 40, color: "warning.main" }} />}
      title="Workflow Setup Required"
      description={buildSummary(
        warning.missingModels.length,
        warning.missingNodeTypes.length,
        modelsToShow.length > 0,
      )}
      models={modelsToShow}
      loading={loading}
      loadingLabel="Loading workflow download options..."
      error={error}
      activeDownloads={activeDownloads}
      anyLocalDownloadActive={anyLocalDownloadActive}
      variant="plain"
      fillHeight
      beforeModels={
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Button
            fullWidth
            variant="outlined"
            size="small"
            startIcon={<OpenInNew />}
            onClick={onOpenEditor}
            sx={{ textTransform: "none" }}
          >
            Open ComfyUI Editor
          </Button>
          {renderWarningList("Missing nodes", warning.missingNodeTypes)}
          {renderWarningList("Missing models", warning.missingModels)}
        </Box>
      }
      onDownload={handleDownload}
      onDownloadAll={handleDownloadAll}
      onCancel={handleCancel}
      onDismissError={dismissError}
      onAdoptExternalJob={adoptExternalJob}
    />
  );
}
