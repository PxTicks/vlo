import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "../../../../types/RuntimeStatus";

vi.mock("../../hooks/useGenerationPanel", () => ({
  useGenerationPanel: vi.fn(),
}));

vi.mock("../../components/ComfyUIEditor", () => ({
  ComfyUIEditor: ({
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  }) =>
    open ? (
      <button type="button" onClick={onClose}>
        Close editor
      </button>
    ) : null,
}));

vi.mock("../../components/GenerationInputs", () => ({
  GenerationInputs: () => null,
}));

vi.mock("../../services/comfyuiApi", async () => {
  const actual = await vi.importActual<typeof import("../../services/comfyuiApi")>(
    "../../services/comfyuiApi",
  );

  return {
    ...actual,
    getObjectInfo: vi.fn(),
    saveWorkflowContent: vi.fn(),
    uploadWorkflowJsonFiles: vi.fn(),
  };
});

import { useGenerationPanel } from "../../hooks/useGenerationPanel";
import { GenerationPanel } from "../../GenerationPanel";
import {
  getObjectInfo,
  saveWorkflowContent,
  uploadWorkflowJsonFiles,
} from "../../services/comfyuiApi";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../../useGenerationStore";

const DEFAULT_RUNTIME_STATUS: RuntimeStatus = {
  backend: {
    status: "ok",
    mode: "development",
    frontendBuildPresent: false,
  },
  comfyui: {
    status: "connected",
    url: "http://localhost:8188",
    error: null,
  },
  sam2: {
    status: "available",
    error: null,
  },
};

function makeHookState(
  overrides: Partial<ReturnType<typeof useGenerationPanel>> = {},
): ReturnType<typeof useGenerationPanel> {
  return {
    editorOpen: true,
    setEditorOpen: vi.fn(),
    urlAnchorEl: null,
    setUrlAnchorEl: vi.fn(),
    urlInput: "",
    setUrlInput: vi.fn(),
    textValues: {},
    handleTextValueCommit: vi.fn(),
    mediaInputs: {},
    latestPreviewUrl: null,
    previewAnimation: null,
    comfyuiDirectUrl: "http://localhost:8188",
    workflowInputs: [],
    activeJob: null,
    activeJobId: null,
    displayJob: undefined,
    availableWorkflows: [{ id: "wf.json", name: "Workflow" }],
    selectedWorkflowId: "wf.json",
    isWorkflowLoading: false,
    isWorkflowReady: true,
    workflowLoadError: null,
    inputValidationFailures: [],
    workflowWarning: null,
    hasInferredInputs: false,
    workflowRuleWarnings: [],
    queuedGenerationCount: 0,
    postprocessingCount: 0,
    isRunning: false,
    isPipelineBusy: false,
    canInterruptCurrentGeneration: false,
    canClearQueuedGenerations: false,
    isPipelineInterruptible: false,
    isPostprocessing: false,
    pipelineStatusText: null,
    canGenerate: false,
    connectionChipLabel: "Connected",
    connectionChipColor: "success",
    connectionSummary: null,
    comfyuiModelDownloadsEnabled: false,
    handleGenerate: vi.fn(),
    handleInterruptCurrent: vi.fn(),
    handleClearQueue: vi.fn(),
    handleUrlSave: vi.fn(),
    handleWorkflowChange: vi.fn(),
    handleRetryWorkflow: vi.fn(),
    handleDismissWorkflowWarning: vi.fn(),
    handleOpenEditorFromWarning: vi.fn(),
    handleInputDrop: vi.fn(),
    handleExternalInputDrop: vi.fn(),
    handleInputClear: vi.fn(),
    handleSwapMediaInputs: vi.fn(),
    handleClickSelect: vi.fn(),
    widgetInputs: [],
    widgetValues: {},
    randomizeToggles: {},
    handleWidgetChange: vi.fn(),
    handleToggleRandomize: vi.fn(),
    connectionStatus: "connected",
    runtimeStatus: DEFAULT_RUNTIME_STATUS,
    runtimeStatusError: null,
    importedAssets: [],
    sendableAssets: [],
    handleSendToTimeline: vi.fn(),
    ...overrides,
  };
}

function resetGenerationStore(
  fetchWorkflows = vi.fn(),
  loadWorkflow = vi.fn(),
) {
  useGenerationStore.setState({
    activeWorkflowRules: null,
    derivedMaskMappings: [],
    maskCropMode: "crop",
    maskCropDilation: 0.1,
    exactAspectRatio: false,
    targetResolution: 1080,
    syncedGraphData: { nodes: [{ id: 1 }] },
    selectedWorkflowId: "wf.json",
    fetchWorkflows,
    loadWorkflow,
    setTargetResolution: vi.fn(),
    setExactAspectRatio: vi.fn(),
    setMaskCropMode: vi.fn(),
    setMaskCropDilation: vi.fn(),
  });

  return { fetchWorkflows, loadWorkflow };
}

describe("GenerationPanel workflow save prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGenerationStore();
  });

  it("closes immediately when the editor workflow is unchanged", () => {
    const setEditorOpen = vi.fn();
    vi.mocked(useGenerationPanel).mockReturnValue(
      makeHookState({ setEditorOpen }),
    );

    render(<GenerationPanel />);
    fireEvent.click(screen.getByText("Close editor"));

    expect(setEditorOpen).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Save workflow changes?")).not.toBeInTheDocument();
  }, 10000);

  it("prompts to save and reuses the backend save path when the workflow changes", async () => {
    const setEditorOpen = vi.fn();
    const { fetchWorkflows } = resetGenerationStore(
      vi.fn().mockResolvedValue(undefined),
    );
    vi.mocked(getObjectInfo).mockResolvedValue({ LoadImage: { input: {} } });
    vi.mocked(saveWorkflowContent).mockResolvedValue(undefined);
    vi.mocked(useGenerationPanel).mockReturnValue(
      makeHookState({ setEditorOpen }),
    );

    render(<GenerationPanel />);

    await act(async () => {
      useGenerationStore.setState({
        syncedGraphData: { nodes: [{ id: 1 }, { id: 2 }] },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    expect(screen.getByText("Save workflow changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(getObjectInfo).toHaveBeenCalledTimes(1);
      expect(saveWorkflowContent).toHaveBeenCalledWith(
        "wf.json",
        { nodes: [{ id: 1 }, { id: 2 }] },
        { LoadImage: { input: {} } },
      );
      expect(fetchWorkflows).toHaveBeenCalledTimes(1);
      expect(setEditorOpen).toHaveBeenCalledWith(false);
    });
  }, 10000);

  it("appends .json when saving edited workflows with a bare selected id", async () => {
    const setEditorOpen = vi.fn();
    const { fetchWorkflows } = resetGenerationStore(
      vi.fn().mockResolvedValue(undefined),
    );
    useGenerationStore.setState({
      selectedWorkflowId: "wf",
      syncedGraphData: { nodes: [{ id: 1 }, { id: 4 }] },
    });
    vi.mocked(getObjectInfo).mockResolvedValue({ LoadImage: { input: {} } });
    vi.mocked(saveWorkflowContent).mockResolvedValue(undefined);
    vi.mocked(useGenerationPanel).mockReturnValue(
      makeHookState({
        setEditorOpen,
        selectedWorkflowId: "wf",
        availableWorkflows: [{ id: "wf", name: "Workflow" }],
      }),
    );

    render(<GenerationPanel />);

    await act(async () => {
      useGenerationStore.setState({
        syncedGraphData: { nodes: [{ id: 1 }, { id: 4 }, { id: 5 }] },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(saveWorkflowContent).toHaveBeenCalledWith(
        "wf.json",
        { nodes: [{ id: 1 }, { id: 4 }, { id: 5 }] },
        { LoadImage: { input: {} } },
      );
      expect(fetchWorkflows).toHaveBeenCalledTimes(1);
      expect(setEditorOpen).toHaveBeenCalledWith(false);
    });
  }, 10000);

  it("allows closing without saving after the editor workflow changes", async () => {
    const setEditorOpen = vi.fn();
    vi.mocked(useGenerationPanel).mockReturnValue(
      makeHookState({ setEditorOpen }),
    );

    render(<GenerationPanel />);

    await act(async () => {
      useGenerationStore.setState({
        syncedGraphData: { nodes: [{ id: 1 }, { id: 3 }] },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));

    expect(saveWorkflowContent).not.toHaveBeenCalled();
    expect(setEditorOpen).toHaveBeenCalledWith(false);
  }, 10000);

  it("saves a temp workflow as a new backend workflow", async () => {
    const setEditorOpen = vi.fn();
    const { fetchWorkflows } = resetGenerationStore(
      vi.fn().mockResolvedValue(undefined),
    );
    useGenerationStore.setState({
      availableWorkflows: [{ id: TEMP_WORKFLOW_ID, name: "Unsaved Workflow" }],
      selectedWorkflowId: TEMP_WORKFLOW_ID,
      tempWorkflow: {
        workflow: { "1": { class_type: "LoadImage", inputs: {} } },
        graphData: { nodes: [{ id: 1 }, { id: 2 }] },
        inputs: [],
      },
      syncedGraphData: { nodes: [{ id: 1 }, { id: 2 }] },
    });
    vi.mocked(getObjectInfo).mockResolvedValue({ LoadImage: { input: {} } });
    vi.mocked(saveWorkflowContent).mockResolvedValue(undefined);
    vi.mocked(useGenerationPanel).mockReturnValue(
      makeHookState({
        setEditorOpen,
        availableWorkflows: [{ id: TEMP_WORKFLOW_ID, name: "Unsaved Workflow" }],
        selectedWorkflowId: TEMP_WORKFLOW_ID,
      }),
    );

    render(<GenerationPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    expect(screen.getByText("Save new workflow?")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Workflow name"), {
      target: { value: "brand_new_workflow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getObjectInfo).toHaveBeenCalledTimes(1);
      expect(saveWorkflowContent).toHaveBeenCalledWith(
        "brand_new_workflow.json",
        { nodes: [{ id: 1 }, { id: 2 }] },
        { LoadImage: { input: {} } },
      );
      expect(fetchWorkflows).toHaveBeenCalledTimes(1);
      expect(setEditorOpen).toHaveBeenCalledWith(false);
    });

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("brand_new_workflow.json");
    expect(state.tempWorkflow).toBeNull();
    expect(
      state.availableWorkflows.some((workflow) => workflow.id === TEMP_WORKFLOW_ID),
    ).toBe(false);
  }, 10000);

  it("uploads dropped workflow json files and loads the uploaded workflow", async () => {
    const { fetchWorkflows, loadWorkflow } = resetGenerationStore(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    );
    vi.mocked(uploadWorkflowJsonFiles).mockResolvedValue([
      {
        filename: "dragged-workflow.json",
        kind: "workflow",
        workflow_id: "dragged-workflow.json",
      },
      {
        filename: "dragged-workflow.rules.json",
        kind: "rules",
        workflow_id: "dragged-workflow.json",
      },
    ]);
    vi.mocked(useGenerationPanel).mockReturnValue(makeHookState());

    render(<GenerationPanel />);

    const panel = screen.getByTestId("generation-panel");
    const workflowFile = new File(['{"nodes":[{"id":1}]}'], "dragged-workflow.json", {
      type: "application/json",
    });
    const rulesFile = new File(['{"name":"Dragged"}'], "dragged-workflow.rules.json", {
      type: "application/json",
    });

    fireEvent.drop(panel, {
      dataTransfer: {
        files: [workflowFile, rulesFile],
        items: [
          { kind: "file", type: "application/json" },
          { kind: "file", type: "application/json" },
        ],
      },
    });

    await waitFor(() => {
      expect(uploadWorkflowJsonFiles).toHaveBeenCalledWith([
        workflowFile,
        rulesFile,
      ]);
      expect(fetchWorkflows).toHaveBeenCalledTimes(1);
      expect(loadWorkflow).toHaveBeenCalledWith("dragged-workflow.json");
    });
  });

  it("reloads the selected workflow when a matching rules sidecar is dropped", async () => {
    const { fetchWorkflows, loadWorkflow } = resetGenerationStore(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    );
    vi.mocked(uploadWorkflowJsonFiles).mockResolvedValue([
      {
        filename: "wf.rules.json",
        kind: "rules",
        workflow_id: "wf.json",
      },
    ]);
    vi.mocked(useGenerationPanel).mockReturnValue(makeHookState());

    render(<GenerationPanel />);

    const panel = screen.getByTestId("generation-panel");
    const rulesFile = new File(['{"name":"Updated"}'], "wf.rules.json", {
      type: "application/json",
    });

    fireEvent.drop(panel, {
      dataTransfer: {
        files: [rulesFile],
        items: [{ kind: "file", type: "application/json" }],
      },
    });

    await waitFor(() => {
      expect(uploadWorkflowJsonFiles).toHaveBeenCalledWith([rulesFile]);
      expect(fetchWorkflows).toHaveBeenCalledTimes(1);
      expect(loadWorkflow).toHaveBeenCalledWith("wf.json");
    });
  });
});
