import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
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
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";
import { AppMenu } from "../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../core/shell/menuDescriptors";

import {
  Stop,
  PlayArrow,
  ArrowBack,
  ArrowDropDown,
  Close,
  OpenInNew,
  Timeline,
} from "@mui/icons-material";
import { ComfyUIEditor } from "./components/ComfyUIEditor";
import { GenerationInputs } from "./components/GenerationInputs";
import {
  DEFAULT_GENERATION_RESOLUTION_OPTIONS,
  getAspectRatioStage,
  getPipelineWidgetKey,
  getSupportedWorkflowResolutions,
  isPipelineWidgetNodeId,
  resolvePipelineWidgetInputs,
  type WorkflowRules,
} from "./services/workflowRules";
import { normalizeWorkflowFilename } from "./services/workflowFilenames";
import { useGenerationPanel } from "./hooks/useGenerationPanel";
import {
  TEMP_WORKFLOW_ID,
  useGenerationStore,
  type PreviewAnimation,
} from "./useGenerationStore";
import { getOutputMediaKindFromFilename } from "./constants/mediaKinds";
import {
  getObjectInfo,
  saveWorkflowContent,
  uploadWorkflowJsonFiles,
} from "./services/comfyuiApi";
import { resolveNodeDisplayTitle } from "./services/nodeTitles";
import { isAspectRatioWidget } from "./utils/aspectRatioWidgets";
import { WorkflowDependencyResolver } from "./components/WorkflowDependencyResolver";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "./utils/workflowInputs";
import { ExtensionUiSlot } from "../extensions/ui/publicApi";
import { extensionGenerationBridge } from "../extensions/generation/ExtensionGenerationBridge";
import { NestedMenuTree } from "../panelUI";
import { useMenuTreeLayout } from "../../core/shell/useMenuTreeLayout";
import { resolveMenuTreeLayout } from "../../core/shell/menuTree";
import { useWorkflowMenuDefinition } from "./hooks/useWorkflowMenuDefinition";
import {
  getComfyuiInstallStatus,
  launchComfyui,
  prepareComfyuiEnvironment,
  type ComfyuiInstallStatus,
} from "../../services/runtimeApi";

const EXACT_ASPECT_RATIO_TOOLTIP =
  "If selected, this will make the output aspect ratio exactly match the input ratio, even if it doesn't match the project-supported aspect ratios. If unselected, it will crop the image to the best supported fit before dispatch.";

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

function resolveGraphNode(
  graphData: Record<string, unknown> | null,
  nodeId: string,
): Record<string, unknown> | null {
  const nodes = graphData?.nodes;
  if (!Array.isArray(nodes)) return null;

  const node = nodes.find((candidate) => {
    if (!isRecord(candidate)) return false;
    return String(candidate.id) === nodeId;
  });
  return isRecord(node) ? node : null;
}

function resolveActiveNodeName(
  nodeId: string | null,
  workflow: Record<string, unknown> | null,
  workflowRules: WorkflowRules | null,
  graphData: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
): string | null {
  if (!nodeId) return null;

  const workflowNode = workflow ? workflow[nodeId] : null;
  const workflowNodeRecord = isRecord(workflowNode) ? workflowNode : null;
  const workflowMeta = isRecord(workflowNodeRecord?._meta)
    ? workflowNodeRecord._meta
    : null;
  const graphNode = resolveGraphNode(graphData, nodeId);
  const classType =
    typeof workflowNodeRecord?.class_type === "string"
      ? workflowNodeRecord.class_type
      : typeof graphNode?.type === "string"
        ? graphNode.type
        : undefined;

  return resolveNodeDisplayTitle({
    workflowTitle: workflowMeta?.title,
    graphTitle: graphNode?.title,
    ruleTitle: workflowRules?.nodes?.[nodeId]?.node_title,
    classType,
    objectInfo,
  });
}

function formatActiveNodeStatus(
  nodeId: string | null,
  workflow: Record<string, unknown> | null,
  workflowRules: WorkflowRules | null,
  graphData: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
): string | null {
  if (!nodeId) return null;

  const nodeName = resolveActiveNodeName(
    nodeId,
    workflow,
    workflowRules,
    graphData,
    objectInfo,
  );
  if (!nodeName || nodeName === nodeId) return null;

  return `Node: ${nodeName}`;
}

const PREVIEW_STYLE: React.CSSProperties = {
  width: "100%",
  borderRadius: 4,
  display: "block",
};

function extractDroppedWorkflowJsonFiles(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files).filter((file) =>
    /\.json$/i.test(file.name.trim()),
  );
}

function hasExternalFileTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) {
    return true;
  }
  if (
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  ) {
    return true;
  }
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

function isLikelyWorkflowJsonTransfer(
  dataTransfer: DataTransfer | null,
): boolean {
  if (!dataTransfer) return false;

  const droppedFiles = extractDroppedWorkflowJsonFiles(dataTransfer);
  if (droppedFiles.length > 0) {
    return true;
  }

  return Array.from(dataTransfer.items ?? []).some((item) => {
    if (item.kind !== "file") return false;
    const normalizedType = item.type.toLowerCase();
    return normalizedType.length === 0 || normalizedType.includes("json");
  });
}

function LivePreview({
  animation,
  fallbackUrl,
}: {
  animation: PreviewAnimation | null;
  fallbackUrl: string | null;
}) {
  return (
    <LivePreviewPlayback animation={animation} fallbackUrl={fallbackUrl} />
  );
}

function LivePreviewPlayback({
  animation,
  fallbackUrl,
}: {
  animation: PreviewAnimation | null;
  fallbackUrl: string | null;
}) {
  const [tick, setTick] = useState(0);
  const animationFrameRate = animation?.frameRate ?? 0;

  useEffect(() => {
    if (animationFrameRate <= 0) return;
    const interval = setInterval(() => {
      setTick((currentTick) => currentTick + 1);
    }, 1000 / animationFrameRate);
    return () => clearInterval(interval);
  }, [animationFrameRate]);

  if (animation) {
    const populated = animation.frameUrls.filter((u): u is string => u != null);
    if (populated.length > 0) {
      const url = populated[tick % populated.length];
      return <img src={url} alt="Generation preview" style={PREVIEW_STYLE} />;
    }
  }

  if (fallbackUrl) {
    return (
      <img src={fallbackUrl} alt="Generation preview" style={PREVIEW_STYLE} />
    );
  }

  return null;
}

export function GenerationPanel() {
  const workflowMenuDefinition = useWorkflowMenuDefinition();
  const [isBackendSavePending, setIsBackendSavePending] = useState(false);
  const [isWorkflowUploadPending, setIsWorkflowUploadPending] = useState(false);
  const [isWorkflowJsonDragActive, setIsWorkflowJsonDragActive] =
    useState(false);
  const [workflowMode, setWorkflowMode] = useState<"rules" | "manual">("rules");
  const selectedWorkflowIdForMode = useGenerationStore((s) => s.selectedWorkflowId);
  const rulesWorkflowSourceId = useGenerationStore((s) => s.rulesWorkflowSourceId);
  const hasRulesMode =
    selectedWorkflowIdForMode === TEMP_WORKFLOW_ID
      ? rulesWorkflowSourceId !== null
      : selectedWorkflowIdForMode !== null &&
        rulesWorkflowSourceId === selectedWorkflowIdForMode;
  const effectiveWorkflowMode = hasRulesMode ? workflowMode : "manual";
  const previousWorkflowIdForModeRef = useRef<string | null>(null);
  const previousHasRulesModeRef = useRef(hasRulesMode);
  const [generateMenuAnchorEl, setGenerateMenuAnchorEl] =
    useState<HTMLElement | null>(null);
  const [customGenerateDialogOpen, setCustomGenerateDialogOpen] =
    useState(false);
  const [customGenerateCount, setCustomGenerateCount] = useState("1");
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [isLaunchingComfyui, setIsLaunchingComfyui] = useState(false);
  const [comfyuiLaunchError, setComfyuiLaunchError] = useState<string | null>(
    null,
  );
  const [comfyuiLaunchMessage, setComfyuiLaunchMessage] = useState<
    string | null
  >(null);
  const [pythonChoiceOpen, setPythonChoiceOpen] = useState(false);
  const [pythonPath, setPythonPath] = useState("");
  const [environmentSetupStatus, setEnvironmentSetupStatus] =
    useState<ComfyuiInstallStatus | null>(null);
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
    handleTextValuesCommit,
    mediaInputs,

    // Widget state
    widgetInputs,
    widgetValues,
    randomizeToggles,
    handleWidgetChange,
    handleToggleRandomize,

    // Derived
    connectionStatus,
    runtimeStatus,
    latestPreviewUrl,
    previewAnimation,
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
    canInterruptCurrentGeneration,
    canClearQueuedGenerations,
    pipelineStatusText,
    canGenerate,
    connectionChipLabel,
    connectionChipColor,
    connectionSummary,
    comfyuiModelDownloadsEnabled,

    // Handlers
    handleGenerate,
    handleInterruptCurrent,
    handleClearQueue,
    handleUrlSave,
    handleWorkflowSelect,
    handleWorkflowBack,
    handleRetryWorkflow,
    handleDismissWorkflowWarning,
    handleOpenEditorFromWarning,
    handleInputDrop,
    handleExternalInputDrop,
    handleInputClear,
    handleSwapMediaInputs,
    handleClickSelect,
    handleEditMedia,

    // Send to timeline
    importedAssets,
    sendableAssets,
    handleSendToTimeline,
  } = useGenerationPanel(effectiveWorkflowMode);
  const configuredInstall =
    runtimeStatus?.settings?.comfyuiInstallVerification;
  const canLaunchLocalComfyui =
    runtimeStatus !== null &&
    runtimeStatus.comfyui.status !== "connected" &&
    connectionStatus !== "connecting" &&
    configuredInstall?.valid === true &&
    Boolean(configuredInstall.installPath);

  useEffect(() => {
    if (
      runtimeStatus?.comfyui.status !== "connected" ||
      connectionStatus !== "connected"
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setComfyuiLaunchError(null);
      setComfyuiLaunchMessage(null);
      setPythonChoiceOpen(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [connectionStatus, runtimeStatus?.comfyui.status]);

  useEffect(() => {
    if (!environmentSetupStatus?.running) return;
    let active = true;
    let pollInFlight = false;
    const interval = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      void getComfyuiInstallStatus()
        .then(async (status) => {
          if (!active) return;
          setEnvironmentSetupStatus(status);
          if (status.phase === "failed") {
            setComfyuiLaunchMessage(null);
            setComfyuiLaunchError(
              status.error ?? "Failed to create the ComfyUI environment",
            );
            return;
          }
          if (status.phase !== "complete") return;

          const result = await launchComfyui();
          if (!active) return;
          if (result.requiresPythonChoice) {
            setPythonChoiceOpen(true);
            setComfyuiLaunchMessage(null);
            return;
          }
          setComfyuiLaunchMessage(
            result.alreadyRunning
              ? "ComfyUI is running; waiting for it to become ready…"
              : "ComfyUI started; waiting for it to become ready…",
          );
          void useGenerationStore.getState().refreshRuntimeStatus();
        })
        .catch((err: unknown) => {
          if (!active) return;
          setComfyuiLaunchMessage(null);
          setComfyuiLaunchError(
            err instanceof Error
              ? err.message
              : "Failed to prepare the ComfyUI environment",
          );
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [environmentSetupStatus?.running]);

  const requestComfyuiLaunch = async (
    options: { pythonPath?: string; useSystemPython?: boolean } = {},
  ) => {
    setIsLaunchingComfyui(true);
    setComfyuiLaunchError(null);
    setComfyuiLaunchMessage(null);
    try {
      const result = await launchComfyui(options);
      if (result.requiresPythonChoice) {
        setPythonChoiceOpen(true);
        return;
      }
      setPythonChoiceOpen(false);
      setComfyuiLaunchMessage(
        result.alreadyRunning
          ? "ComfyUI is running; waiting for it to become ready…"
          : "ComfyUI started; waiting for it to become ready…",
      );
      void useGenerationStore.getState().refreshRuntimeStatus();
    } catch (err) {
      setComfyuiLaunchError(
        err instanceof Error ? err.message : "Failed to launch ComfyUI",
      );
    } finally {
      setIsLaunchingComfyui(false);
    }
  };

  const handlePrepareComfyuiEnvironment = async () => {
    setIsLaunchingComfyui(true);
    setComfyuiLaunchError(null);
    try {
      const status = await prepareComfyuiEnvironment();
      setEnvironmentSetupStatus(status);
      setPythonChoiceOpen(false);
      setComfyuiLaunchMessage(
        status.message ?? "Creating a managed ComfyUI environment…",
      );
    } catch (err) {
      setComfyuiLaunchError(
        err instanceof Error
          ? err.message
          : "Failed to create the ComfyUI environment",
      );
    } finally {
      setIsLaunchingComfyui(false);
    }
  };

  const comfyuiIsReady =
    runtimeStatus?.comfyui.status === "connected" &&
    connectionStatus === "connected";
  const comfyuiStatusResolving =
    runtimeStatus === null ||
    connectionStatus === "connecting" ||
    (runtimeStatus.comfyui.status === "connected" &&
      connectionStatus !== "connected");

  const derivedMaskMappings = useGenerationStore((s) => s.derivedMaskMappings);
  const activeWorkflowRules = useGenerationStore((s) => s.activeWorkflowRules);
  const targetResolution = useGenerationStore((s) => s.targetResolution);
  const setTargetResolution = useGenerationStore((s) => s.setTargetResolution);
  const exactAspectRatio = useGenerationStore((s) => s.exactAspectRatio);
  const setExactAspectRatio = useGenerationStore((s) => s.setExactAspectRatio);
  const maskCropMode = useGenerationStore((s) => s.maskCropMode);
  const setMaskCropMode = useGenerationStore((s) => s.setMaskCropMode);
  const maskCropDilation = useGenerationStore((s) => s.maskCropDilation);
  const setMaskCropDilation = useGenerationStore((s) => s.setMaskCropDilation);
  const syncedWorkflow = useGenerationStore((s) => s.syncedWorkflow);
  const syncedGraphData = useGenerationStore((s) => s.syncedGraphData);
  const rawObjectInfo = useGenerationStore((s) => s.rawObjectInfo);
  const workflowLeafIds = useMemo(
    () => availableWorkflows.map((workflow) => workflow.id),
    [availableWorkflows],
  );
  const workflowMenuLeaves = useMemo(
    () =>
      availableWorkflows.map((workflow) => ({
        id: workflow.id,
        label: workflow.name,
      })),
    [availableWorkflows],
  );
  const selectedWorkflowLabel = selectedWorkflowId
    ? workflowMenuLeaves.find((workflow) => workflow.id === selectedWorkflowId)
        ?.label ?? selectedWorkflowId
    : null;
  const workflowMenuLayout = useMenuTreeLayout(
    workflowMenuDefinition,
    workflowLeafIds,
  );
  const defaultWorkflowMenuLayout = useMemo(
    () =>
      resolveMenuTreeLayout(
        workflowMenuDefinition,
        null,
        workflowLeafIds,
      ),
    [workflowMenuDefinition, workflowLeafIds],
  );
  const fetchWorkflows = useGenerationStore((s) => s.fetchWorkflows);
  const loadWorkflow = useGenerationStore((s) => s.loadWorkflow);
  const hasMaskMappings = derivedMaskMappings.length > 0;
  const aspectRatioProcessingConfig = getAspectRatioStage(activeWorkflowRules);
  const hasAspectRatioTargets =
    (aspectRatioProcessingConfig?.targets?.length ?? 0) > 0;
  const showResolutionSelector = Boolean(
    aspectRatioProcessingConfig?.enabled !== false && hasAspectRatioTargets,
  );
  const showRulesResolutionSelector =
    effectiveWorkflowMode === "rules" && showResolutionSelector;
  const supportedResolutions =
    getSupportedWorkflowResolutions(activeWorkflowRules);
  const resolutionOptions: number[] =
    supportedResolutions.length > 0
      ? supportedResolutions
      : [...DEFAULT_GENERATION_RESOLUTION_OPTIONS];
  const currentResolution = resolutionOptions.includes(targetResolution)
    ? targetResolution
    : resolutionOptions[0];
  const pipelineWidgetInputs = useMemo(
    () =>
      resolvePipelineWidgetInputs(activeWorkflowRules, {
        showTargetResolution: showRulesResolutionSelector,
        currentResolution,
        showMaskControls: effectiveWorkflowMode === "rules" && hasMaskMappings,
        maskCropMode,
        maskCropDilation,
      }),
    [
      activeWorkflowRules,
      currentResolution,
      hasMaskMappings,
      maskCropDilation,
      maskCropMode,
      effectiveWorkflowMode,
      showRulesResolutionSelector,
    ],
  );
  const displayWidgetInputs = useMemo(
    () => [...pipelineWidgetInputs, ...widgetInputs],
    [pipelineWidgetInputs, widgetInputs],
  );
  const extensionGenerationInputLookup = useMemo(
    () => buildWorkflowInputLookup(workflowInputs),
    [workflowInputs],
  );
  const extensionGenerationInputs = useMemo(
    () =>
      workflowInputs.map((input) => {
        const id = getWorkflowInputId(input);
        const textValue =
          input.inputType === "text"
            ? (getWorkflowInputValue(
                textValues,
                input,
                extensionGenerationInputLookup,
              ) ??
              (typeof input.currentValue === "string"
                ? input.currentValue
                : ""))
            : undefined;
        return Object.freeze({
          id,
          nodeId: input.nodeId,
          param: input.param,
          label: input.label,
          ...(input.description ? { description: input.description } : {}),
          inputType: input.inputType,
          ...(textValue !== undefined ? { value: textValue } : {}),
        });
      }),
    [extensionGenerationInputLookup, textValues, workflowInputs],
  );

  useEffect(
    () =>
      extensionGenerationBridge.mount({
        listInputs: () => extensionGenerationInputs,
        commitTextInputs: handleTextValuesCommit,
      }),
    [extensionGenerationInputs, handleTextValuesCommit],
  );
  const exactAspectRatioWidgetKey = useMemo(() => {
    if (!showRulesResolutionSelector) {
      return null;
    }

    const aspectRatioWidget = displayWidgetInputs.find(isAspectRatioWidget);
    if (aspectRatioWidget) {
      return `${aspectRatioWidget.nodeId}:${aspectRatioWidget.param}`;
    }

    if (!aspectRatioProcessingConfig) {
      return null;
    }

    return getPipelineWidgetKey(
      aspectRatioProcessingConfig.id,
      "target_resolution",
    );
  }, [
    aspectRatioProcessingConfig,
    displayWidgetInputs,
    showRulesResolutionSelector,
  ]);
  const canSaveWorkflowToBackend =
    !isBackendSavePending &&
    !!syncedGraphData &&
    !!selectedWorkflowId &&
    selectedWorkflowId !== TEMP_WORKFLOW_ID;
  const currentWorkflowSignature = useMemo(
    () => buildWorkflowSignature(syncedGraphData),
    [syncedGraphData],
  );

  useEffect(() => {
    if (!hasRulesMode && workflowMode === "rules") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWorkflowMode("manual");
    }
  }, [hasRulesMode, workflowMode]);

  useEffect(() => {
    const workflowChanged =
      previousWorkflowIdForModeRef.current !== selectedWorkflowIdForMode;
    const rulesJustBecameAvailable =
      !previousHasRulesModeRef.current && hasRulesMode;

    if (hasRulesMode && (workflowChanged || rulesJustBecameAvailable)) {
      setWorkflowMode("rules");
    }

    previousWorkflowIdForModeRef.current = selectedWorkflowIdForMode;
    previousHasRulesModeRef.current = hasRulesMode;
  }, [hasRulesMode, selectedWorkflowIdForMode]);
  const activeNodeStatus = useMemo(
    () =>
      formatActiveNodeStatus(
        activeJob?.currentNode ?? null,
        syncedWorkflow,
        activeWorkflowRules,
        syncedGraphData,
        rawObjectInfo,
      ),
    [
      activeJob?.currentNode,
      activeWorkflowRules,
      rawObjectInfo,
      syncedGraphData,
      syncedWorkflow,
    ],
  );
  const hasVisibleGenerationControls =
    workflowInputs.length > 0 || displayWidgetInputs.length > 0;

  const handleDisplayedWidgetChange = useCallback(
    (nodeId: string, param: string, value: unknown) => {
      if (!isPipelineWidgetNodeId(nodeId)) {
        handleWidgetChange(nodeId, param, value);
        return;
      }

      if (param === "target_resolution" && typeof value === "number") {
        setTargetResolution(value);
        return;
      }

      if (param === "crop_mode" && (value === "crop" || value === "full")) {
        setMaskCropMode(value);
        return;
      }

      if (param === "crop_dilation" && typeof value === "number") {
        setMaskCropDilation(value);
      }
    },
    [
      handleWidgetChange,
      setMaskCropDilation,
      setMaskCropMode,
      setTargetResolution,
    ],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    if (hasInferredInputs) {
      console.debug("[GenerationPanel] Using inferred workflow inputs", {
        workflowId: selectedWorkflowId,
      });
    }

    if (workflowRuleWarnings.length > 0) {
      console.debug("[GenerationPanel] Workflow rule warnings", {
        workflowId: selectedWorkflowId,
        warnings: workflowRuleWarnings,
      });
    }
  }, [hasInferredInputs, selectedWorkflowId, workflowRuleWarnings]);

  const refreshMissingModelsFromIframe = useGenerationStore(
    (s) => s.refreshMissingModelsFromIframe,
  );
  const previousEditorOpenRef = useRef(editorOpen);

  const [lastEditorSessionKey, setLastEditorSessionKey] = useState<
    string | null
  >(`${editorOpen}|${selectedWorkflowId ?? ""}`);
  const currentEditorSessionKey = `${editorOpen}|${selectedWorkflowId ?? ""}`;
  useEffect(() => {
    if (lastEditorSessionKey === currentEditorSessionKey) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastEditorSessionKey(currentEditorSessionKey);
    if (!editorOpen) {
      setSavePromptOpen(false);
    }
    setEditorSessionBaselineSignature(null);
    setEditorHasUnsavedChanges(false);
  }, [currentEditorSessionKey, editorOpen, lastEditorSessionKey]);

  // When the user closes the ComfyUI editor, re-run the missing-model
  // pipeline in the iframe so anything they fixed in there (picking a
  // different model in a combo widget, downloading via ComfyUI's own UI)
  // updates pendingWarnings; otherwise the panel keeps showing the stale
  // download options and the gen inputs stay hidden. Do not fall back to a
  // full workflow reload here: closing the editor may be preserving manual
  // widget/model selections that only live in the iframe.
  useEffect(() => {
    const wasOpen = previousEditorOpenRef.current;
    previousEditorOpenRef.current = editorOpen;
    if (!wasOpen || editorOpen) return;
    void refreshMissingModelsFromIframe();
  }, [editorOpen, refreshMissingModelsFromIframe]);

  // Capture the workflow signature baseline as soon as it becomes available
  // and flag unsaved changes once the signature drifts from the baseline.
  useEffect(() => {
    if (
      editorOpen &&
      !isWorkflowLoading &&
      currentWorkflowSignature &&
      editorSessionBaselineSignature === null
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditorSessionBaselineSignature(currentWorkflowSignature);
    }
  }, [
    currentWorkflowSignature,
    editorOpen,
    editorSessionBaselineSignature,
    isWorkflowLoading,
  ]);
  useEffect(() => {
    if (
      editorOpen &&
      !isWorkflowLoading &&
      currentWorkflowSignature &&
      editorSessionBaselineSignature !== null &&
      currentWorkflowSignature !== editorSessionBaselineSignature &&
      !editorHasUnsavedChanges
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditorHasUnsavedChanges(true);
    }
  }, [
    currentWorkflowSignature,
    editorHasUnsavedChanges,
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
      const objectInfo = rawObjectInfo ?? (await getObjectInfo());
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
      const objectInfo = rawObjectInfo ?? (await getObjectInfo());
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
  const showInlineWorkflowResolver =
    Boolean(workflowWarning) && comfyuiModelDownloadsEnabled;
  const showWorkflowWarningDialog =
    Boolean(workflowWarning) && !editorOpen && !comfyuiModelDownloadsEnabled;
  const displayPostprocessConfig = displayJob?.postprocessConfig ?? null;
  const replaceOutputsWithPostprocess =
    displayPostprocessConfig?.panel_preview === "replace_outputs";
  const showPostprocessErrorOnly =
    replaceOutputsWithPostprocess &&
    displayPostprocessConfig?.on_failure === "show_error" &&
    Boolean(displayJob?.postprocessError);
  const showPostprocessWarning =
    displayJob?.status !== "error" &&
    !showPostprocessErrorOnly &&
    Boolean(displayJob?.postprocessError);
  const importedPreviewAsset = importedAssets[0] ?? null;
  const importedPreviewSrc = importedPreviewAsset
    ? importedPreviewAsset.src
    : "";
  const showRunningCancelControls = canInterruptCurrentGeneration;
  const shouldShowRawOutputs =
    displayJob && displayJob.outputs.length > 0
      ? !importedPreviewAsset &&
        (!replaceOutputsWithPostprocess ||
          (!displayJob?.postprocessedPreview && !showPostprocessErrorOnly))
      : false;
  const customGenerateCountValue = Number.parseInt(customGenerateCount, 10);
  const isCustomGenerateCountValid =
    Number.isFinite(customGenerateCountValue) && customGenerateCountValue > 0;

  function blurActiveElement(): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function handleGenerateCount(count: number): void {
    blurActiveElement();
    void handleGenerate(count);
  }

  function handleOpenGenerateMenu(event: MouseEvent<HTMLElement>): void {
    setGenerateMenuAnchorEl(event.currentTarget);
  }

  function handleCloseGenerateMenu(): void {
    setGenerateMenuAnchorEl(null);
  }

  function handleSelectGenerateCount(count: number): void {
    handleCloseGenerateMenu();
    handleGenerateCount(count);
  }

  function handleOpenCustomGenerateDialog(): void {
    handleCloseGenerateMenu();
    setCustomGenerateCount("1");
    setCustomGenerateDialogOpen(true);
  }

  function handleCloseCustomGenerateDialog(): void {
    setCustomGenerateDialogOpen(false);
  }

  function handleSubmitCustomGenerateDialog(): void {
    if (!isCustomGenerateCountValid) {
      return;
    }
    setCustomGenerateDialogOpen(false);
    handleGenerateCount(customGenerateCountValue);
  }

  function handleWorkflowJsonDragOver(event: DragEvent<HTMLElement>): void {
    if (!hasExternalFileTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    if (isLikelyWorkflowJsonTransfer(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "copy";
    }
    if (
      !isWorkflowJsonDragActive &&
      isLikelyWorkflowJsonTransfer(event.dataTransfer)
    ) {
      setIsWorkflowJsonDragActive(true);
    } else if (
      isWorkflowJsonDragActive &&
      !isLikelyWorkflowJsonTransfer(event.dataTransfer)
    ) {
      setIsWorkflowJsonDragActive(false);
    }
  }

  function handleWorkflowJsonDragLeave(event: DragEvent<HTMLElement>): void {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setIsWorkflowJsonDragActive(false);
  }

  async function handleWorkflowJsonDrop(
    event: DragEvent<HTMLElement>,
  ): Promise<void> {
    if (hasExternalFileTransfer(event.dataTransfer)) {
      event.preventDefault();
    }
    const files = extractDroppedWorkflowJsonFiles(event.dataTransfer);
    setIsWorkflowJsonDragActive(false);

    if (files.length === 0) {
      return;
    }

    event.stopPropagation();
    setIsWorkflowUploadPending(true);

    try {
      const uploaded = await uploadWorkflowJsonFiles(files);
      await fetchWorkflows();

      const uploadedWorkflow = uploaded.find(
        (file) => file.kind === "workflow",
      );
      if (uploadedWorkflow) {
        await loadWorkflow(uploadedWorkflow.workflow_id);
        return;
      }

      if (
        selectedWorkflowId &&
        uploaded.some((file) => file.workflow_id === selectedWorkflowId)
      ) {
        await loadWorkflow(selectedWorkflowId);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to upload workflow JSON files";
      alert(message);
    } finally {
      setIsWorkflowUploadPending(false);
    }
  }

  return (
    <Box
      data-testid="generation-panel"
      onDragOver={handleWorkflowJsonDragOver}
      onDragLeave={handleWorkflowJsonDragLeave}
      onDrop={(event) => {
        void handleWorkflowJsonDrop(event);
      }}
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        position: "relative",
        overflowY: "auto",
        outline: isWorkflowJsonDragActive
          ? (theme) => `1px dashed ${theme.palette.primary.main}`
          : "none",
        outlineOffset: -1,
      }}
    >
      {isWorkflowJsonDragActive ? (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "rgba(0, 0, 0, 0.35)",
            px: 3,
          }}
        >
          <Typography
            variant="body2"
            sx={{
              px: 2,
              py: 1.25,
              borderRadius: 1,
              bgcolor: "rgba(17, 17, 17, 0.92)",
              border: "1px solid rgba(255, 255, 255, 0.16)",
              textAlign: "center",
            }}
          >
            Drop workflow JSON files to upload them to the backend workflow
            directory.
          </Typography>
        </Box>
      ) : null}

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
          <ExtensionUiSlot slot="generation.toolbar" presentation="inline" />
          <Chip
            data-testid="generation-connection-chip"
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
            disabled={connectionStatus !== "connected"}
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
        {comfyuiStatusResolving ? (
          <Box
            sx={{
              p: 2,
              display: "flex",
              alignItems: "center",
              gap: 1,
              color: "text.secondary",
            }}
          >
            <CircularProgress size={16} />
            <Typography variant="caption">Connecting to ComfyUI…</Typography>
          </Box>
        ) : !comfyuiIsReady ? (
          <Box
            sx={{
              p: 2,
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 1,
              bgcolor: "background.paper",
            }}
          >
            <Typography variant="subtitle2">ComfyUI is not connected</Typography>
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
            >
              Connect a running instance before choosing a generation
              workflow.
            </Typography>
            {canLaunchLocalComfyui ? (
              <Button
                variant="contained"
                size="small"
                onClick={() => void requestComfyuiLaunch()}
                disabled={isLaunchingComfyui}
                sx={{ mt: 1.5, textTransform: "none" }}
              >
                {isLaunchingComfyui ? "Launching ComfyUI…" : "Launch ComfyUI"}
              </Button>
            ) : null}
            {comfyuiLaunchMessage ? (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mt: 1 }}
              >
                {comfyuiLaunchMessage}
              </Typography>
            ) : null}
            {comfyuiLaunchError ? (
              <Typography
                variant="caption"
                sx={{ color: "error.main", display: "block", mt: 1 }}
              >
                {comfyuiLaunchError}
              </Typography>
            ) : null}
          </Box>
        ) : selectedWorkflowId ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Tooltip title="Back to workflow menu">
              <IconButton
                aria-label="Back to workflow menu"
                onClick={handleWorkflowBack}
              >
                <ArrowBack />
              </IconButton>
            </Tooltip>
            <Typography
              variant="subtitle2"
              noWrap
              // Without this the flex item keeps its content width and the
              // name runs past the panel instead of ellipsising.
              sx={{ minWidth: 0 }}
              title={selectedWorkflowLabel ?? undefined}
            >
              {selectedWorkflowLabel}
            </Typography>
          </Box>
        ) : (
          <NestedMenuTree
            ariaLabel="Generation workflows"
            layout={workflowMenuLayout.layout}
            defaultLayout={defaultWorkflowMenuLayout}
            leaves={workflowMenuLeaves}
            onLeafActivate={(workflow) =>
              handleWorkflowSelect(workflow.id)
            }
            onSave={workflowMenuLayout.save}
            onReset={workflowMenuLayout.reset}
            isLoading={workflowMenuLayout.isLoading}
            isSaving={workflowMenuLayout.isSaving}
            persistenceError={workflowMenuLayout.error}
          />
        )}
        {comfyuiIsReady &&
        !selectedWorkflowId &&
        workflowLoadError ? (
          <Box sx={{ mt: 1 }}>
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
              Retry workflow discovery
            </Button>
          </Box>
        ) : null}
        {isWorkflowUploadPending && (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 0.75 }}
          >
            Uploading workflow JSON files...
          </Typography>
        )}
      </Box>

      {selectedWorkflowId ? (
        <>
          <Box sx={{ px: 2, pb: 2 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="generation-mode-label">Mode</InputLabel>
              <Select
                labelId="generation-mode-label"
                value={effectiveWorkflowMode}
                label="Mode"
                onChange={(event) =>
                  setWorkflowMode(event.target.value as "rules" | "manual")
                }
                sx={{ bgcolor: "#1a1a1a" }}
              >
                {hasRulesMode ? (
                  <MenuItem value="rules">Rules</MenuItem>
                ) : null}
                <MenuItem value="manual">Manual</MenuItem>
              </Select>
            </FormControl>
          </Box>

          {showInlineWorkflowResolver ? (
            <WorkflowDependencyResolver
              workflowId={selectedWorkflowId}
              warning={workflowWarning!}
              onOpenEditor={() => setEditorOpen(true)}
              onRefreshWarning={handleRetryWorkflow}
            />
          ) : (
            <>
              {isWorkflowLoading ? (
                <Box
                  sx={{
                    px: 2,
                    pb: 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                  }}
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
              ) : !hasVisibleGenerationControls ? (
                <Box sx={{ px: 2, pb: 2 }}>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    No inputs detected (or workflow has no editable parameters).
                    <br />
                    Open the ComfyUI editor to inspect.
                  </Typography>
                </Box>
              ) : null}

              {!isWorkflowLoading && !workflowLoadError ? (
                <>
                  <GenerationInputs
                    inputs={workflowInputs}
                    sections={activeWorkflowRules?.sections ?? []}
                    textValues={textValues}
                    onTextValueCommit={handleTextValueCommit}
                    mediaInputs={mediaInputs}
                    onInputDrop={handleInputDrop}
                    onExternalInputDrop={handleExternalInputDrop}
                    onInputClear={handleInputClear}
                    onSwapMediaInputs={handleSwapMediaInputs}
                    onClickSelect={handleClickSelect}
                    onEditMedia={handleEditMedia}
                    widgetInputs={displayWidgetInputs}
                    widgetValues={widgetValues}
                    randomizeToggles={randomizeToggles}
                    onWidgetChange={handleDisplayedWidgetChange}
                    onToggleRandomize={handleToggleRandomize}
                    showExactAspectRatioControl={showRulesResolutionSelector}
                    exactAspectRatioWidgetKey={exactAspectRatioWidgetKey}
                    exactAspectRatio={exactAspectRatio}
                    onExactAspectRatioChange={setExactAspectRatio}
                    exactAspectRatioTooltip={EXACT_ASPECT_RATIO_TOOLTIP}
                  />
                  <ExtensionUiSlot slot="generation.inputs.after" />
                </>
              ) : null}

              {effectiveWorkflowMode === "manual" ? (
                <Box sx={{ px: 2, pb: 1 }}>
                  <Button
                    fullWidth
                    variant="outlined"
                    startIcon={<OpenInNew />}
                    onClick={() => setEditorOpen(true)}
                    sx={{ textTransform: "none" }}
                  >
                    Edit workflow
                  </Button>
                </Box>
              ) : null}

              {/* Generate / Cancel Button */}
              <Box sx={{ px: 2, py: 2 }}>
                <Box sx={{ display: "flex", width: "100%" }}>
                  <Tooltip
                    title={
                      !canGenerate && inputValidationFailures.length > 0
                        ? inputValidationFailures
                            .slice(0, 4)
                            .map((f) => f.message)
                            .join("\n")
                        : ""
                    }
                    placement="top"
                    arrow
                    slotProps={{
                      tooltip: { sx: { whiteSpace: "pre-line" } },
                    }}
                  >
                    <span style={{ display: "flex", flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: "flex", flex: 1, minWidth: 0 }}>
                        <Button
                          data-testid="generation-generate-button"
                          fullWidth
                          variant="contained"
                          startIcon={<PlayArrow />}
                          disabled={!canGenerate}
                          onPointerDown={blurActiveElement}
                          onClick={() => handleGenerateCount(1)}
                          sx={{
                            borderBottomRightRadius: 0,
                            borderTopRightRadius: 0,
                            textTransform: "none",
                          }}
                        >
                          Generate
                        </Button>
                        <Button
                          aria-label="Queue multiple generations"
                          disabled={!canGenerate}
                          onClick={handleOpenGenerateMenu}
                          sx={{
                            borderBottomLeftRadius: 0,
                            borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                            borderBottomRightRadius: showRunningCancelControls
                              ? 0
                              : 4,
                            borderTopLeftRadius: 0,
                            borderTopRightRadius: showRunningCancelControls ? 0 : 4,
                            minWidth: 44,
                            px: 1,
                          }}
                          variant="contained"
                        >
                          <ArrowDropDown />
                        </Button>
                      </Box>
                    </span>
                  </Tooltip>
                  {showRunningCancelControls ? (
                    <>
                      <Tooltip title="Cancel current generation" arrow>
                        <span style={{ display: "flex" }}>
                          <Button
                            aria-label="Cancel current generation"
                            color="warning"
                            disabled={!canInterruptCurrentGeneration}
                            onClick={handleInterruptCurrent}
                            sx={{
                              borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                              borderRadius: 0,
                              minWidth: 48,
                              px: 1,
                            }}
                            variant="contained"
                          >
                            <Close />
                          </Button>
                        </span>
                      </Tooltip>
                      <Tooltip title="Clear queue" arrow>
                        <span style={{ display: "flex" }}>
                          <Button
                            aria-label="Clear queue"
                            color="error"
                            disabled={!canClearQueuedGenerations}
                            onClick={handleClearQueue}
                            sx={{
                              borderBottomLeftRadius: 0,
                              borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                              borderTopLeftRadius: 0,
                              minWidth: 48,
                              px: 1,
                            }}
                            variant="contained"
                          >
                            <Stop />
                          </Button>
                        </span>
                      </Tooltip>
                    </>
                  ) : null}
                </Box>
                {pipelineStatusText ? (
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary", display: "block", mt: 1 }}
                  >
                    {pipelineStatusText}
                  </Typography>
                ) : null}
              </Box>

              <AppMenu
                menuId="generation.generate.options"
                subject={{
                  slot: "generation.generate.options",
                  generation: { workflowId: selectedWorkflowId ?? null },
                }}
                items={[
                  ...[2, 4, 8, 16].map(
                    (count): HostMenuItemDescriptor => ({
                      kind: "action",
                      id: `generate-x${count}`,
                      label: `x ${count}`,
                      group: "1_batch",
                      run: () => handleSelectGenerateCount(count),
                    }),
                  ),
                  {
                    kind: "action",
                    id: "queue-custom",
                    label: "Queue custom...",
                    group: "2_custom",
                    run: handleOpenCustomGenerateDialog,
                  },
                ]}
                open={Boolean(generateMenuAnchorEl)}
                onClose={handleCloseGenerateMenu}
                anchorEl={generateMenuAnchorEl}
              />

              {/* Progress */}
              {isRunning && activeJob && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <LinearProgress
                    data-testid="generation-progress-bar"
                    variant={
                      activeJob.progress > 0 ? "determinate" : "indeterminate"
                    }
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
              {(latestPreviewUrl || previewAnimation) && isRunning && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <LivePreview
                    animation={previewAnimation}
                    fallbackUrl={latestPreviewUrl}
                  />
                </Box>
              )}

              {/* Postprocessed Preview */}
              {displayJob?.postprocessedPreview &&
                replaceOutputsWithPostprocess && (
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
                      {getOutputMediaKindFromFilename(output.filename) ===
                      "video" ? (
                        <video
                          src={output.viewUrl}
                          controls
                          autoPlay
                          loop
                          muted
                          style={{
                            width: "100%",
                            borderRadius: 4,
                            display: "block",
                          }}
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
                          style={{
                            width: "100%",
                            borderRadius: 4,
                            display: "block",
                          }}
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
                    {importedAssets.length > 1
                      ? ` (+${importedAssets.length - 1} more)`
                      : ""}
                  </Typography>
                </Box>
              )}

              {/* Send to Timeline */}
              {sendableAssets.length > 0 && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <Button
                    data-testid="generation-send-to-timeline-button"
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

              {/* Warning */}
              {showPostprocessWarning && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <Typography variant="caption" sx={{ color: "warning.main" }}>
                    Warning: {displayJob?.postprocessError}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </>
      ) : null}

      <Dialog
        open={pythonChoiceOpen}
        onClose={() => setPythonChoiceOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Choose a ComfyUI Python environment</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 2 }}>
            No virtual environment or portable Python installation was found.
            Choose an existing Python executable, let vlo create a managed
            environment inside the ComfyUI checkout, or explicitly use the
            Python interpreter running vlo.
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="Existing Python executable"
            value={pythonPath}
            onChange={(event) => setPythonPath(event.target.value)}
            placeholder={
              navigator.platform.startsWith("Win")
                ? "C:\\path\\to\\venv\\Scripts\\python.exe"
                : "/path/to/venv/bin/python"
            }
          />
        </DialogContent>
        <DialogActions sx={{ flexWrap: "wrap" }}>
          <Button onClick={() => setPythonChoiceOpen(false)}>Cancel</Button>
          <Button
            onClick={() => void handlePrepareComfyuiEnvironment()}
            disabled={isLaunchingComfyui}
          >
            Create managed environment
          </Button>
          <Button
            onClick={() =>
              void requestComfyuiLaunch({ useSystemPython: true })
            }
            disabled={isLaunchingComfyui}
          >
            Use vlo Python
          </Button>
          <Button
            variant="contained"
            onClick={() =>
              void requestComfyuiLaunch({ pythonPath: pythonPath.trim() })
            }
            disabled={isLaunchingComfyui || !pythonPath.trim()}
          >
            Use selected Python
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={customGenerateDialogOpen}
        onClose={handleCloseCustomGenerateDialog}
      >
        <DialogTitle>Queue Custom Generations</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Generation count"
            margin="dense"
            type="number"
            value={customGenerateCount}
            onChange={(event) => setCustomGenerateCount(event.target.value)}
            error={!isCustomGenerateCountValid}
            helperText="Enter a positive whole number."
            inputProps={{ min: 1, step: 1 }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSubmitCustomGenerateDialog();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseCustomGenerateDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSubmitCustomGenerateDialog}
            disabled={!isCustomGenerateCountValid}
          >
            Queue
          </Button>
        </DialogActions>
      </Dialog>

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
            Workflow successfully edited for current session. Do you you want to
            save the changes for the future?
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
