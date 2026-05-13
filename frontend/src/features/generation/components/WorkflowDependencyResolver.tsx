import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { OpenInNew, WarningAmberOutlined } from "@mui/icons-material";
import {
  getAvailableModels,
  startModelDownload,
  type DownloadableModel,
} from "../../../services/downloadApi";
import { ModelDownloadPanel } from "../../../shared/components/ModelDownloadPanel";
import { useModelDownloadController } from "../../../shared/hooks/useModelDownloadController";
import type { WorkflowWarningSummary } from "../services/workflowBridge";

interface WorkflowDependencyResolverProps {
  workflowId: string | null;
  warning: WorkflowWarningSummary;
  onOpenEditor: () => void;
  onRefreshWarning: () => void;
}

const MAX_VISIBLE_ITEMS = 6;

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

  const fetchWorkflowModels = useCallback(async () => {
    if (!workflowId || warning.missingModels.length === 0) {
      setWorkflowModels([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await getAvailableModels({ workflowId });
      setWorkflowModels(response.comfyui?.workflowModels ?? []);
    } catch {
      setWorkflowModels([]);
    } finally {
      setLoading(false);
    }
  }, [warning.missingModels.length, workflowId]);

  useEffect(() => {
    void fetchWorkflowModels();
  }, [fetchWorkflowModels]);

  const modelsToShow = useMemo(
    () => resolveSuggestedModels(workflowModels, warning.missingModels),
    [warning.missingModels, workflowModels],
  );

  const {
    activeDownload,
    error,
    handleDownload,
    handleCancel,
  } = useModelDownloadController({
    startDownload: (modelKey, context) =>
      startModelDownload("comfyui-workflow", modelKey, {
        workflowId: workflowId ?? undefined,
        hfToken: context?.hfToken,
      }),
    onDownloadComplete: () => {
      onRefreshWarning();
      void fetchWorkflowModels();
    },
  });

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
      activeDownload={activeDownload}
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
      onCancel={handleCancel}
    />
  );
}
