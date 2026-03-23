import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useGenerationPanel", () => ({
  useGenerationPanel: vi.fn(),
}));

import { useGenerationPanel } from "../../hooks/useGenerationPanel";
import { GenerationPanel } from "../../GenerationPanel";
import { createDefaultWorkflowRules } from "../../services/workflowRules";
import type { GenerationJob } from "../../types";
import { useGenerationStore } from "../../useGenerationStore";

function makeHookState(overrides: Record<string, unknown> = {}) {
  return {
    editorOpen: false,
    setEditorOpen: vi.fn(),
    urlAnchorEl: null,
    setUrlAnchorEl: vi.fn(),
    urlInput: "",
    setUrlInput: vi.fn(),
    textValues: {},
    handleTextValueCommit: vi.fn(),
    mediaInputs: {},
    latestPreviewUrl: null,
    comfyuiDirectUrl: "http://localhost:8188",
    workflowInputs: [],
    activeJob: null,
    activeJobId: null,
    displayJob: null,
    availableWorkflows: [{ id: "wf.json", name: "Workflow" }],
    selectedWorkflowId: "wf.json",
    isWorkflowLoading: false,
    workflowLoadError: null,
    inputValidationFailures: [],
    workflowWarning: null,
    hasInferredInputs: false,
    workflowRuleWarnings: [],
    isRunning: false,
    isPipelineBusy: false,
    isPipelineInterruptible: false,
    isPostprocessing: false,
    pipelineStatusText: null,
    isExtractingSelection: false,
    generateButtonLabel: "Generate",
    canGenerate: false,
    connectionChipLabel: "Connected",
    connectionChipColor: "success",
    connectionSummary: null,
    handleRetryWorkflow: vi.fn(),
    handleGenerate: vi.fn(),
    handleCancel: vi.fn(),
    handleUrlSave: vi.fn(),
    handleWorkflowChange: vi.fn(),
    handleDismissWorkflowWarning: vi.fn(),
    handleOpenEditorFromWarning: vi.fn(),
    handleInputDrop: vi.fn(),
    handleInputClear: vi.fn(),
    handleClickSelect: vi.fn(),
    widgetInputs: [],
    widgetValues: {},
    randomizeToggles: {},
    handleWidgetChange: vi.fn(),
    handleToggleRandomize: vi.fn(),
    connectionStatus: "connected",
    isWorkflowReady: true,
    importedAssets: [],
    sendableAssets: [],
    handleSendToTimeline: vi.fn(),
    ...overrides,
  };
}

function makeCompletedJob(
  overrides: Partial<GenerationJob> = {},
): GenerationJob {
  return {
    id: "job-1",
    status: "completed",
    progress: 100,
    currentNode: null,
    outputs: [
      {
        filename: "raw-output.png",
        subfolder: "",
        type: "output",
        viewUrl: "/raw-output.png",
      },
    ],
    error: null,
    submittedAt: Date.now() - 1000,
    completedAt: Date.now(),
    postprocessConfig: {
      mode: "stitch_frames_with_audio",
      panel_preview: "replace_outputs",
      on_failure: "show_error",
    },
    postprocessedPreview: null,
    postprocessError: null,
    ...overrides,
  };
}

describe("GenerationPanel workflow rule hints", () => {
  beforeEach(() => {
    useGenerationStore.setState({
      activeWorkflowRules: null,
      derivedMaskMappings: [],
      maskCropMode: "crop",
      maskCropDilation: 0.1,
      syncedWorkflow: null,
      syncedGraphData: null,
      targetResolution: 1080,
      setTargetResolution: vi.fn(),
    });
  });

  it("shows inferred input experimental hint", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        workflowInputs: [
          {
            nodeId: "6",
            classType: "CLIPTextEncode",
            inputType: "text",
            param: "text",
            label: "Prompt",
            currentValue: "",
            origin: "inferred",
          },
        ],
        hasInferredInputs: true,
      }),
    );

    render(<GenerationPanel />);
    expect(
      screen.getByText("Inferred inputs - experimental feature"),
    ).toBeInTheDocument();
  }, 10000);

  it("shows mask processing mode and hides dilation slider in full mode", () => {
    useGenerationStore.setState({
      derivedMaskMappings: [
        {
          sourceNodeId: "1",
          maskNodeId: "2",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      maskCropMode: "full",
    });
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState(),
    );

    render(<GenerationPanel />);
    expect(screen.getByLabelText("Mask processing")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("shows generation resolution only for workflows with aspect ratio processing", () => {
    useGenerationStore.setState({
      activeWorkflowRules: createDefaultWorkflowRules({
        aspect_ratio_processing: {
          enabled: true,
          stride: 16,
          search_steps: 2,
          resolutions: [480, 720],
          target_nodes: [],
          postprocess: {
            enabled: true,
            mode: "stretch_exact",
            apply_to: "all_visual_outputs",
          },
        },
      }),
    });
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState(),
    );

    render(<GenerationPanel />);

    expect(screen.getByLabelText("Resolution")).toBeInTheDocument();
    expect(
      screen.getByText("Generation resolution controls the short edge before strided resize."),
    ).toBeInTheDocument();
  });

  it("renders rule warnings inline", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        workflowRuleWarnings: [
          {
            code: "unknown_widget_type",
            message: "Unrecognized widget type 'custom_slider'",
            node_id: "144",
          },
        ],
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("Workflow rule warnings")).toBeInTheDocument();
    expect(
      screen.getByText("[144] Unrecognized widget type 'custom_slider'"),
    ).toBeInTheDocument();
  });

  it("shows only postprocessed preview when replace mode has preview", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessedPreview: {
            previewUrl: "blob:postprocessed",
            mediaKind: "video",
            filename: "postprocessed.webm",
          },
        }),
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("Postprocessed preview")).toBeInTheDocument();
    expect(screen.queryByText("Generated outputs")).not.toBeInTheDocument();
    expect(screen.queryByAltText("raw-output.png")).not.toBeInTheDocument();
  });

  it("shows cancel with preparing-asset status during preprocess", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        isPipelineBusy: true,
        isPipelineInterruptible: true,
        pipelineStatusText: "Preparing asset",
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByText("Preparing asset")).toBeInTheDocument();
  });

  it("shows the active node name while running", () => {
    useGenerationStore.setState({
      syncedWorkflow: {
        "12": {
          class_type: "KSampler",
          inputs: {},
          _meta: { title: "Main sampler" },
        },
      },
    });
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        isRunning: true,
        activeJob: makeCompletedJob({
          status: "running",
          completedAt: null,
          progress: 42,
          currentNode: "12",
        }),
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("42% — Node: Main sampler")).toBeInTheDocument();
  });

  it("locks the button and shows rendering-generation status during postprocess", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        isPipelineBusy: true,
        isPostprocessing: true,
        pipelineStatusText: "Rendering generation",
        generateButtonLabel: "Rendering generation",
      }),
    );

    render(<GenerationPanel />);
    expect(
      screen.getByRole("button", { name: "Rendering generation" }),
    ).toBeDisabled();
    expect(screen.getAllByText("Rendering generation")).toHaveLength(2);
  });

  it("shows postprocess error only when replace mode is configured with show_error", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessedPreview: null,
          postprocessError: "Postprocessing failed",
        }),
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("Error: Postprocessing failed")).toBeInTheDocument();
    expect(screen.queryByText("Generated outputs")).not.toBeInTheDocument();
    expect(screen.queryByAltText("raw-output.png")).not.toBeInTheDocument();
  });

  it("shows raw outputs in raw_outputs panel mode", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessConfig: {
            mode: "auto",
            panel_preview: "raw_outputs",
            on_failure: "fallback_raw",
          },
          postprocessedPreview: null,
        }),
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("Generated outputs")).toBeInTheDocument();
    expect(screen.getByAltText("raw-output.png")).toBeInTheDocument();
  });

  it("shows imported asset preview when ingested assets exist", () => {
    const { container } = renderWithImportedVideoPreview();

    expect(screen.getByText("Imported asset preview")).toBeInTheDocument();
    expect(screen.getByText("stitched.webm")).toBeInTheDocument();
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:video");
  });

  it("uses the original imported asset source instead of the proxy source for video preview", () => {
    const { container } = renderWithImportedVideoPreview({
      proxySrc: "blob:proxy-video",
    });

    expect(container.querySelector("video")).toHaveAttribute("src", "blob:video");
    expect(container.querySelector("video")).not.toHaveAttribute(
      "src",
      "blob:proxy-video",
    );
  });

  it("shows send to timeline whenever sendable assets exist", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          status: "error",
          error: "Postprocess warning",
        }),
        sendableAssets: [
          {
            id: "asset-1",
            hash: "hash-1",
            name: "clip.webm",
            type: "video",
            src: "blob:video",
            createdAt: Date.now(),
            creationMetadata: {
              source: "extracted",
              timelineSelection: {
                start: 0,
                end: 120,
                clips: [],
              },
            },
          },
        ],
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByRole("button", { name: "Send to Timeline" })).toBeInTheDocument();
  });
});

function renderWithImportedVideoPreview(
  assetOverrides: Record<string, unknown> = {},
) {
  (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          outputs: [],
          postprocessConfig: {
            mode: "auto",
            panel_preview: "raw_outputs",
            on_failure: "fallback_raw",
          },
          postprocessedPreview: null,
        }),
        importedAssets: [
          {
            id: "asset-1",
            hash: "hash-1",
            name: "stitched.webm",
            type: "video",
            src: "blob:video",
            createdAt: Date.now(),
            ...assetOverrides,
          },
        ],
      }),
    );

  return render(<GenerationPanel />);
}
