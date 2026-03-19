import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Typography,
  Button,
  LinearProgress,
  CircularProgress,
  Chip,
  IconButton,
  Popover,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Slider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";

import {
  Stop,
  PlayArrow,
  OpenInNew,
  Timeline,
} from "@mui/icons-material";
import { ComfyUIEditor } from "./components/ComfyUIEditor";
import { GenerationInputs } from "./components/GenerationInputs";
import {
  DEFAULT_GENERATION_RESOLUTION_OPTIONS,
  getSupportedWorkflowResolutions,
  type WorkflowRules,
} from "./services/workflowRules";
import { normalizeWorkflowFilename } from "./services/workflowFilenames";
import { useGenerationPanel } from "./hooks/useGenerationPanel";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "./useGenerationStore";
import { getOutputMediaKindFromFilename } from "./constants/mediaKinds";
import { getObjectInfo, saveWorkflowContent } from "./services/comfyuiApi";

function buildWorkflowSignature(
  graphData: Record<string, unknown> | null,
): string | null {
  if (!graphData) return null;

  try {
    return JSON.stringify(graphData);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNodeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGraphNodeName(
  graphData: Record<string, unknown> | null,
  nodeId: string,
): string | null {
  const nodes = graphData?.nodes;
  if (!Array.isArray(nodes)) return null;

  const node = nodes.find((candidate) => {
    if (!isRecord(candidate)) return false;
    return String(candidate.id) === nodeId;
  });
  if (!isRecord(node)) return null;

  return normalizeNodeName(node.title) ?? normalizeNodeName(node.type);
}

function resolveActiveNodeName(
  nodeId: string | null,
  workflow: Record<string, unknown> | null,
  workflowRules: WorkflowRules | null,
  graphData: Record<string, unknown> | null,
): string | null {
  if (!nodeId) return null;

  const workflowNode = workflow ? workflow[nodeId] : null;
  const workflowNodeRecord = isRecord(workflowNode) ? workflowNode : null;
  const workflowMeta = isRecord(workflowNodeRecord?._meta)
    ? workflowNodeRecord._meta
    : null;

  return (
    normalizeNodeName(workflowMeta?.title) ??
    resolveGraphNodeName(graphData, nodeId) ??
    normalizeNodeName(workflowRules?.nodes[nodeId]?.node_title) ??
    normalizeNodeName(workflowNodeRecord?.class_type)
  );
}

function formatActiveNodeStatus(
  nodeId: string | null,
  workflow: Record<string, unknown> | null,
  workflowRules: WorkflowRules | null,
  graphData: Record<string, unknown> | null,
): string | null {
  if (!nodeId) return null;

  const nodeName = resolveActiveNodeName(
    nodeId,
    workflow,
    workflowRules,
    graphData,
  );
  if (!nodeName || nodeName === nodeId) return null;

  return `Node: ${nodeName}`;
}

export function GenerationPanel() {
  const [isBackendSavePending, setIsBackendSavePending] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [newWorkflowNamePromptOpen, setNewWorkflowNamePromptOpen] =
    useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [editorSessionBaselineSignature, setEditorSessionBaselineSignature] =
    useState<string | null>(null);
  const [editorHasUnsavedChanges, setEditorHasUnsavedChanges] = useState(false);
  const {
    // State
    editorOpen,
    setEditorOpen,
    urlAnchorEl,
    setUrlAnchorEl,
    urlInput,
    setUrlInput,
    textValues,
    handleTextValueCommit,
    mediaInputs,

    // Widget state
    widgetInputs,
    widgetValues,
    randomizeToggles,
    handleWidgetChange,
    handleToggleRandomize,

    // Derived
    latestPreviewUrl,
    comfyuiDirectUrl,
    workflowInputs,
    activeJob,
    displayJob,
    availableWorkflows,
    selectedWorkflowId,
    isWorkflowLoading,
    workflowLoadError,
    workflowWarning,
    hasInferredInputs,
    workflowRuleWarnings,
    inputValidationFailures,
    isRunning,
    isPipelineBusy,
    isPipelineInterruptible,
    isPostprocessing,
    pipelineStatusText,
    isExtractingSelection,
    generateButtonLabel,
    canGenerate,
    connectionChipLabel,
    connectionChipColor,
    connectionSummary,

    // Handlers
    handleGenerate,
    handleCancel,
    handleUrlSave,
    handleWorkflowChange,
    handleRetryWorkflow,
    handleDismissWorkflowWarning,
    handleOpenEditorFromWarning,
    handleInputDrop,
    handleInputClear,
    handleClickSelect,

    // Send to timeline
    importedAssets,
    sendableAssets,
    handleSendToTimeline,
  } = useGenerationPanel();

  const derivedMaskMappings = useGenerationStore(
    (s) => s.derivedMaskMappings,
  );
  const activeWorkflowRules = useGenerationStore((s) => s.activeWorkflowRules);
  const targetResolution = useGenerationStore((s) => s.targetResolution);
  const setTargetResolution = useGenerationStore((s) => s.setTargetResolution);
  const maskCropMode = useGenerationStore((s) => s.maskCropMode);
  const setMaskCropMode = useGenerationStore((s) => s.setMaskCropMode);
  const maskCropDilation = useGenerationStore((s) => s.maskCropDilation);
  const setMaskCropDilation = useGenerationStore((s) => s.setMaskCropDilation);
  const syncedWorkflow = useGenerationStore((s) => s.syncedWorkflow);
  const syncedGraphData = useGenerationStore((s) => s.syncedGraphData);
  const fetchWorkflows = useGenerationStore((s) => s.fetchWorkflows);
  const hasMaskMappings = derivedMaskMappings.length > 0;
  const aspectRatioProcessingConfig =
    activeWorkflowRules?.aspect_ratio_processing ?? null;
  const showResolutionSelector = Boolean(aspectRatioProcessingConfig?.enabled);
  const supportedResolutions =
    getSupportedWorkflowResolutions(activeWorkflowRules);
  const resolutionOptions: number[] =
    supportedResolutions.length > 0
      ? supportedResolutions
      : [...DEFAULT_GENERATION_RESOLUTION_OPTIONS];
  const currentResolution = resolutionOptions.includes(targetResolution)
    ? targetResolution
    : resolutionOptions[0];
  const canSaveWorkflowToBackend =
    !isBackendSavePending &&
    !!syncedGraphData &&
    !!selectedWorkflowId &&
    selectedWorkflowId !== TEMP_WORKFLOW_ID;
  const currentWorkflowSignature = useMemo(
    () => buildWorkflowSignature(syncedGraphData),
    [syncedGraphData],
  );
  const activeNodeStatus = useMemo(
    () =>
      formatActiveNodeStatus(
        activeJob?.currentNode ?? null,
        syncedWorkflow,
        activeWorkflowRules,
        syncedGraphData,
      ),
    [
      activeJob?.currentNode,
      activeWorkflowRules,
      syncedGraphData,
      syncedWorkflow,
    ],
  );

  useEffect(() => {
    if (!editorOpen) {
      setSavePromptOpen(false);
      setEditorSessionBaselineSignature(null);
      setEditorHasUnsavedChanges(false);
      return;
    }

    setEditorSessionBaselineSignature(null);
    setEditorHasUnsavedChanges(false);
  }, [editorOpen, selectedWorkflowId]);

  useEffect(() => {
    if (!editorOpen || isWorkflowLoading || !currentWorkflowSignature) {
      return;
    }

    if (editorSessionBaselineSignature === null) {
      setEditorSessionBaselineSignature(currentWorkflowSignature);
      return;
    }

    if (currentWorkflowSignature !== editorSessionBaselineSignature) {
      setEditorHasUnsavedChanges(true);
    }
  }, [
    currentWorkflowSignature,
    editorOpen,
    editorSessionBaselineSignature,
    isWorkflowLoading,
  ]);

  const handleSaveWorkflowToBackend = async (): Promise<boolean> => {
    if (!syncedGraphData || !selectedWorkflowId) return false;
    if (selectedWorkflowId === TEMP_WORKFLOW_ID) return false;
    const filename = normalizeWorkflowFilename(selectedWorkflowId);
    if (!filename) return false;

    setIsBackendSavePending(true);
    try {
      const objectInfo = await getObjectInfo();
      await saveWorkflowContent(filename, syncedGraphData, objectInfo);
      await fetchWorkflows();
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save workflow to backend assets";
      alert(message);
      return false;
    } finally {
      setIsBackendSavePending(false);
    }
  };

  const isTempWorkflow = selectedWorkflowId === TEMP_WORKFLOW_ID;

  const handleRequestCloseEditor = () => {
    if (editorHasUnsavedChanges && canSaveWorkflowToBackend) {
      setSavePromptOpen(true);
      return;
    }

    if (isTempWorkflow && syncedGraphData) {
      setNewWorkflowName("");
      setNewWorkflowNamePromptOpen(true);
      return;
    }

    setEditorOpen(false);
  };

  const handleDiscardEditorChanges = () => {
    setSavePromptOpen(false);
    setEditorHasUnsavedChanges(false);
    setEditorOpen(false);
  };

  const handleDiscardNewWorkflow = () => {
    setNewWorkflowNamePromptOpen(false);
    setEditorOpen(false);
  };

  const handleSaveNewWorkflow = async () => {
    const trimmed = newWorkflowName.trim();
    if (!trimmed || !syncedGraphData) return;

    const filename = normalizeWorkflowFilename(trimmed);
    if (!filename) return;

    setIsBackendSavePending(true);
    try {
      const objectInfo = await getObjectInfo();
      await saveWorkflowContent(filename, syncedGraphData, objectInfo);
      await fetchWorkflows();

      // Promote from temp to the persisted workflow
      useGenerationStore.setState({
        selectedWorkflowId: filename,
        tempWorkflow: null,
        availableWorkflows: useGenerationStore
          .getState()
          .availableWorkflows.filter((w) => w.id !== TEMP_WORKFLOW_ID),
      });

      setNewWorkflowNamePromptOpen(false);
      setEditorHasUnsavedChanges(false);
      setEditorOpen(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save new workflow to backend assets";
      alert(message);
    } finally {
      setIsBackendSavePending(false);
    }
  };

  const handleSaveEditorChanges = async () => {
    const didSave = await handleSaveWorkflowToBackend();
    if (!didSave) return;

    setSavePromptOpen(false);
    setEditorHasUnsavedChanges(false);
    setEditorSessionBaselineSignature(currentWorkflowSignature);
    setEditorOpen(false);
  };

  const missingNodeTypes = workflowWarning?.missingNodeTypes ?? [];
  const missingModels = workflowWarning?.missingModels ?? [];
  const visibleMissingNodeTypes = missingNodeTypes.slice(0, 6);
  const visibleMissingModels = missingModels.slice(0, 6);
  const hiddenNodeCount = Math.max(0, missingNodeTypes.length - 6);
  const hiddenModelCount = Math.max(0, missingModels.length - 6);
  const showWorkflowWarningDialog = Boolean(workflowWarning) && !editorOpen;
  const displayPostprocessConfig = displayJob?.postprocessConfig ?? null;
  const replaceOutputsWithPostprocess =
    displayPostprocessConfig?.panel_preview === "replace_outputs";
  const showPostprocessErrorOnly =
    replaceOutputsWithPostprocess &&
    displayPostprocessConfig?.on_failure === "show_error" &&
    Boolean(displayJob?.postprocessError);
  const shouldShowRawOutputs =
    displayJob && displayJob.outputs.length > 0
      ? !replaceOutputsWithPostprocess ||
        (!displayJob?.postprocessedPreview && !showPostprocessErrorOnly)
      : false;
  const importedPreviewAsset = importedAssets[0] ?? null;
  const importedPreviewSrc = importedPreviewAsset
    ? importedPreviewAsset.type === "video"
      ? importedPreviewAsset.proxySrc ?? importedPreviewAsset.src
      : importedPreviewAsset.src
    : "";

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          p: 2,
          pb: 1,
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Chip
            size="small"
            label={connectionChipLabel}
            color={connectionChipColor}
            variant="outlined"
            onClick={(e) => {
              setUrlInput(comfyuiDirectUrl || "http://localhost:8188");
              setUrlAnchorEl(e.currentTarget);
            }}
            sx={{ fontSize: "0.65rem", height: 20, cursor: "pointer" }}
          />
          <IconButton
            size="small"
            onClick={() => setEditorOpen(true)}
            title="Open ComfyUI Node Editor"
            sx={{ color: "text.secondary" }}
          >
            <OpenInNew fontSize="small" />
          </IconButton>
        </Box>
        <Popover
          open={Boolean(urlAnchorEl)}
          anchorEl={urlAnchorEl}
          onClose={() => setUrlAnchorEl(null)}
          anchorOrigin={{
            vertical: "bottom",
            horizontal: "right",
          }}
          transformOrigin={{
            vertical: "top",
            horizontal: "right",
          }}
        >
          <Box sx={{ p: 2, display: "flex", gap: 1, alignItems: "center" }}>
            <TextField
              size="small"
              label="ComfyUI URL"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleUrlSave();
              }}
              sx={{ minWidth: 200 }}
            />
            <Button
              variant="contained"
              size="small"
              onClick={() => void handleUrlSave()}
            >
              Connect
            </Button>
          </Box>
        </Popover>
      </Box>

      {connectionSummary && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {connectionSummary}
          </Typography>
        </Box>
      )}

      {/* Workflow Selector */}
      <Box sx={{ px: 2, pb: 2 }}>
        <FormControl fullWidth size="small">
          <InputLabel id="workflow-select-label">Workflow</InputLabel>
          <Select
            labelId="workflow-select-label"
            value={selectedWorkflowId ?? ""}
            label="Workflow"
            onChange={handleWorkflowChange}
            sx={{
              bgcolor: "#1a1a1a",
              "& .MuiSelect-select": { py: 1 },
            }}
          >
            {availableWorkflows.map((wf) => (
              <MenuItem key={wf.id} value={wf.id}>
                {wf.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Dynamic Workflow Inputs */}
      {showResolutionSelector && !isWorkflowLoading && (
        <Box sx={{ px: 2, pb: 2 }}>
          <FormControl fullWidth size="small">
            <InputLabel id="generation-resolution-label">Resolution</InputLabel>
            <Select
              labelId="generation-resolution-label"
              value={currentResolution}
              label="Resolution"
              onChange={(event) =>
                setTargetResolution(Number(event.target.value))
              }
              sx={{ bgcolor: "#1a1a1a" }}
            >
              {resolutionOptions.map((resolution) => (
                <MenuItem key={resolution} value={resolution}>
                  {`${resolution}p`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 0.75 }}
          >
            Generation resolution controls the short edge before strided resize.
          </Typography>
        </Box>
      )}

      {isWorkflowLoading ? (
        <Box
          sx={{ px: 2, pb: 2, display: "flex", alignItems: "center", gap: 1 }}
        >
          <CircularProgress size={16} />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Loading inputs...
          </Typography>
        </Box>
      ) : workflowLoadError ? (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "error.main", display: "block", mb: 1 }}
          >
            {workflowLoadError}
          </Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={() => void handleRetryWorkflow()}
            sx={{ textTransform: "none" }}
          >
            Retry workflow load
          </Button>
        </Box>
      ) : workflowInputs.length === 0 ? (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            No inputs detected (or workflow has no editable parameters).
            <br />
            Open the ComfyUI editor to inspect.
          </Typography>
        </Box>
      ) : null}

      {!isWorkflowLoading && hasInferredInputs && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="caption" sx={{ color: "warning.main" }}>
            Inferred inputs - experimental feature
          </Typography>
        </Box>
      )}

      {!isWorkflowLoading && workflowRuleWarnings.length > 0 && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "warning.light", display: "block", mb: 0.5 }}
          >
            Workflow rule warnings
          </Typography>
          {workflowRuleWarnings.slice(0, 4).map((warning, idx) => (
            <Typography
              key={`${warning.code}-${warning.node_id ?? "global"}-${idx}`}
              variant="caption"
              sx={{ color: "warning.main", display: "block", lineHeight: 1.4 }}
            >
              {warning.node_id ? `[${warning.node_id}] ` : ""}
              {warning.message}
            </Typography>
          ))}
        </Box>
      )}

      {!isWorkflowLoading && inputValidationFailures.length > 0 && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "warning.light", display: "block", mb: 0.5 }}
          >
            Generation requirements
          </Typography>
          {inputValidationFailures.slice(0, 4).map((failure, idx) => (
            <Typography
              key={`${failure.kind}-${failure.input ?? failure.inputs?.join("-") ?? "global"}-${idx}`}
              variant="caption"
              sx={{ color: "warning.main", display: "block", lineHeight: 1.4 }}
            >
              {failure.message}
            </Typography>
          ))}
        </Box>
      )}

      <GenerationInputs
        inputs={workflowInputs}
        textValues={textValues}
        onTextValueCommit={handleTextValueCommit}
        mediaInputs={mediaInputs}
        onInputDrop={handleInputDrop}
        onInputClear={handleInputClear}
        onClickSelect={handleClickSelect}
        widgetInputs={widgetInputs}
        widgetValues={widgetValues}
        randomizeToggles={randomizeToggles}
        onWidgetChange={handleWidgetChange}
        onToggleRandomize={handleToggleRandomize}
      />

      {/* Mask processing */}
      {hasMaskMappings && (
        <Box sx={{ px: 2, pb: 2 }}>
          <FormControl
            fullWidth
            size="small"
            sx={{ mb: maskCropMode === "crop" ? 1.5 : 0 }}
          >
            <InputLabel id="mask-processing-mode-label">
              Mask processing
            </InputLabel>
            <Select
              labelId="mask-processing-mode-label"
              value={maskCropMode}
              label="Mask processing"
              onChange={(event) =>
                setMaskCropMode(event.target.value as "crop" | "full")
              }
              sx={{ bgcolor: "#1a1a1a" }}
            >
              <MenuItem value="full">Full</MenuItem>
              <MenuItem value="crop">Crop</MenuItem>
            </Select>
          </FormControl>
          {maskCropMode === "crop" ? (
            <>
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mb: 0.5 }}
              >
                Mask crop padding: {Math.round(maskCropDilation * 100)}%
              </Typography>
              <Slider
                size="small"
                value={maskCropDilation}
                min={0}
                max={0.5}
                step={0.01}
                onChange={(_, value) =>
                  setMaskCropDilation(value as number)
                }
              />
            </>
          ) : null}
        </Box>
      )}

      {/* Generate / Cancel Button */}
      <Box sx={{ px: 2, py: 2 }}>
        {isPipelineInterruptible ? (
          <Button
            fullWidth
            variant="contained"
            color="error"
            startIcon={<Stop />}
            onClick={handleCancel}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
        ) : isPostprocessing ? (
          <Button
            fullWidth
            variant="contained"
            disabled
            sx={{ textTransform: "none" }}
          >
            {generateButtonLabel}
          </Button>
        ) : (
          <Button
            fullWidth
            variant="contained"
            startIcon={isExtractingSelection ? undefined : <PlayArrow />}
            disabled={!canGenerate}
            onPointerDown={() => {
              // Force blur so CommittedTextInput commits its value before onClick fires
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
            }}
            onClick={handleGenerate}
            sx={{ textTransform: "none" }}
          >
            {generateButtonLabel}
          </Button>
        )}
        {isPipelineBusy && pipelineStatusText ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 1 }}
          >
            {pipelineStatusText}
          </Typography>
        ) : null}
      </Box>

      {/* Progress */}
      {isRunning && activeJob && (
        <Box sx={{ px: 2, pb: 2 }}>
          <LinearProgress
            variant={activeJob.progress > 0 ? "determinate" : "indeterminate"}
            value={activeJob.progress}
            sx={{ mb: 0.5, borderRadius: 1 }}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {activeJob.status === "queued"
              ? "Queued..."
              : `${activeJob.progress}%${activeNodeStatus ? ` — ${activeNodeStatus}` : ""}`}
          </Typography>
        </Box>
      )}

      {/* Live Preview */}
      {latestPreviewUrl && isRunning && (
        <Box sx={{ px: 2, pb: 2 }}>
          <img
            src={latestPreviewUrl}
            alt="Generation preview"
            style={{ width: "100%", borderRadius: 4, display: "block" }}
          />
        </Box>
      )}

      {/* Postprocessed Preview */}
      {displayJob?.postprocessedPreview && replaceOutputsWithPostprocess && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mb: 1, display: "block" }}
          >
            Postprocessed preview
          </Typography>
          {displayJob.postprocessedPreview.mediaKind === "video" ? (
            <video
              src={displayJob.postprocessedPreview.previewUrl}
              controls
              autoPlay
              loop
              muted
              style={{ width: "100%", borderRadius: 4, display: "block" }}
            />
          ) : displayJob.postprocessedPreview.mediaKind === "audio" ? (
            <audio
              src={displayJob.postprocessedPreview.previewUrl}
              controls
              style={{ width: "100%", display: "block" }}
            />
          ) : (
            <img
              src={displayJob.postprocessedPreview.previewUrl}
              alt={displayJob.postprocessedPreview.filename}
              style={{ width: "100%", borderRadius: 4, display: "block" }}
            />
          )}
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
          >
            Auto-imported to library
          </Typography>
        </Box>
      )}

      {/* Outputs */}
      {displayJob && shouldShowRawOutputs && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mb: 1, display: "block" }}
          >
            {displayJob.status === "completed"
              ? "Generated outputs"
              : "Outputs so far"}
          </Typography>
          {displayJob.outputs.map((output, i) => (
            <Box key={`${output.filename}-${i}`} sx={{ mb: 1 }}>
              {getOutputMediaKindFromFilename(output.filename) === "video" ? (
                <video
                  src={output.viewUrl}
                  controls
                  autoPlay
                  loop
                  muted
                  style={{ width: "100%", borderRadius: 4, display: "block" }}
                />
              ) : getOutputMediaKindFromFilename(output.filename) ===
                "audio" ? (
                <audio
                  src={output.viewUrl}
                  controls
                  style={{ width: "100%", display: "block" }}
                />
              ) : (
                <img
                  src={output.viewUrl}
                  alt={output.filename}
                  style={{ width: "100%", borderRadius: 4, display: "block" }}
                />
              )}
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
              >
                {displayJob.status === "completed"
                  ? "Auto-imported to library"
                  : output.filename}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      {/* Imported Asset Preview */}
      {displayJob && importedPreviewAsset && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mb: 1, display: "block" }}
          >
            Imported asset preview
          </Typography>
          {importedPreviewAsset.type === "video" ? (
            <video
              src={importedPreviewSrc}
              controls
              autoPlay
              loop
              muted
              style={{ width: "100%", borderRadius: 4, display: "block" }}
            />
          ) : importedPreviewAsset.type === "audio" ? (
            <audio
              src={importedPreviewSrc}
              controls
              style={{ width: "100%", display: "block" }}
            />
          ) : (
            <img
              src={importedPreviewSrc}
              alt={importedPreviewAsset.name}
              style={{ width: "100%", borderRadius: 4, display: "block" }}
            />
          )}
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
          >
            {importedPreviewAsset.name}
            {importedAssets.length > 1 ? ` (+${importedAssets.length - 1} more)` : ""}
          </Typography>
        </Box>
      )}

      {/* Send to Timeline */}
      {sendableAssets.length > 0 && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Button
            fullWidth
            variant="outlined"
            size="small"
            startIcon={<Timeline />}
            onClick={handleSendToTimeline}
            sx={{ textTransform: "none" }}
          >
            Send to Timeline
          </Button>
        </Box>
      )}

      {/* Error */}
      {(displayJob?.status === "error" || showPostprocessErrorOnly) && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography color="error" variant="caption">
            Error:{" "}
            {displayJob?.status === "error"
              ? displayJob.error
              : displayJob?.postprocessError}
          </Typography>
        </Box>
      )}

      <Dialog
        open={showWorkflowWarningDialog}
        onClose={handleDismissWorkflowWarning}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Workflow warnings detected</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            This workflow references nodes or models that are unavailable in
            your ComfyUI environment.
          </Typography>

          {missingNodeTypes.length > 0 && (
            <Box sx={{ mb: missingModels.length > 0 ? 1.5 : 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Missing nodes ({missingNodeTypes.length})
              </Typography>
              <Typography variant="body2">
                {visibleMissingNodeTypes.join(", ")}
                {hiddenNodeCount > 0 ? `, and ${hiddenNodeCount} more` : ""}
              </Typography>
            </Box>
          )}

          {missingModels.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Missing models ({missingModels.length})
              </Typography>
              <Typography variant="body2">
                {visibleMissingModels.join(", ")}
                {hiddenModelCount > 0 ? `, and ${hiddenModelCount} more` : ""}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDismissWorkflowWarning}>Ignore</Button>
          <Button variant="contained" onClick={handleOpenEditorFromWarning}>
            Open ComfyUI Editor
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={savePromptOpen}
        onClose={() => setSavePromptOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Save workflow changes?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            Save the current ComfyUI workflow back to backend assets before
            closing the editor?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDiscardEditorChanges}>Don&apos;t Save</Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveEditorChanges()}
            disabled={isBackendSavePending}
          >
            {isBackendSavePending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={newWorkflowNamePromptOpen}
        onClose={() => setNewWorkflowNamePromptOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Save new workflow?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Save this workflow to backend assets?
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Workflow name"
            value={newWorkflowName}
            onChange={(e) => setNewWorkflowName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newWorkflowName.trim()) {
                void handleSaveNewWorkflow();
              }
            }}
            placeholder="e.g. my_workflow"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDiscardNewWorkflow}>Don&apos;t Save</Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveNewWorkflow()}
            disabled={isBackendSavePending || !newWorkflowName.trim()}
          >
            {isBackendSavePending ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ComfyUI Node Editor Dialog */}
      <ComfyUIEditor open={editorOpen} onClose={handleRequestCloseEditor} />
    </Box>
  );
}
