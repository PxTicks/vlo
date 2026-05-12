import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useGenerationPanel", () => ({
  useGenerationPanel: vi.fn(),
}));
vi.mock("../WorkflowDependencyResolver", () => ({
  WorkflowDependencyResolver: () => (
    <div data-testid="workflow-dependency-resolver" />
  ),
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
    previewAnimation: null,
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
    handleRetryWorkflow: vi.fn(),
    handleGenerate: vi.fn(),
    handleInterruptCurrent: vi.fn(),
    handleClearQueue: vi.fn(),
    handleUrlSave: vi.fn(),
    handleWorkflowChange: vi.fn(),
    handleDismissWorkflowWarning: vi.fn(),
    handleOpenEditorFromWarning: vi.fn(),
    handleInputDrop: vi.fn(),
    handleExternalInputDrop: vi.fn(),
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
      exactAspectRatio: false,
      setExactAspectRatio: vi.fn(),
    });
  });

  it("moves inferred-input and rule warnings to debug logging", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
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

    expect(
      screen.queryByText("Inferred inputs - experimental feature"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow rule warnings")).not.toBeInTheDocument();
    expect(
      debugSpy.mock.calls.some(
        ([message]) => message === "[GenerationPanel] Using inferred workflow inputs",
      ),
    ).toBe(true);
    expect(
      debugSpy.mock.calls.some(
        ([message]) => message === "[GenerationPanel] Workflow rule warnings",
      ),
    ).toBe(true);

    debugSpy.mockRestore();
  }, 10000);

  it("hides stale workflow inputs while a new workflow is loading", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        isWorkflowLoading: true,
        workflowInputs: [
          {
            nodeId: "6",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Reference Image",
            currentValue: null,
            origin: "rule",
          },
        ],
      }),
    );

    render(<GenerationPanel />);

    expect(screen.getByText("Loading inputs...")).toBeInTheDocument();
    expect(screen.queryByText("Reference Image")).not.toBeInTheDocument();
  });

  it("shows the inline workflow resolver when local ComfyUI downloads are enabled", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        workflowWarning: {
          missingNodeTypes: [],
          missingModels: ["model.safetensors"],
        },
        comfyuiModelDownloadsEnabled: true,
      }),
    );

    render(<GenerationPanel />);

    expect(
      screen.getByTestId("workflow-dependency-resolver"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("generation-generate-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Workflow warnings detected"),
    ).not.toBeInTheDocument();
  });

  it("keeps the warning dialog when local ComfyUI downloads are disabled", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        workflowWarning: {
          missingNodeTypes: ["CustomNode"],
          missingModels: ["model.safetensors"],
        },
        comfyuiModelDownloadsEnabled: false,
      }),
    );

    render(<GenerationPanel />);

    expect(screen.getByText("Workflow warnings detected")).toBeInTheDocument();
    expect(
      screen.queryByTestId("workflow-dependency-resolver"),
    ).not.toBeInTheDocument();
  });

  it("shows mask processing mode and hides dilation slider in full mode", () => {
    useGenerationStore.setState({
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            controls: [
              {
                key: "crop_mode",
                label: "Mask crop mode",
                value_type: "enum",
                options: ["crop", "full"],
              },
              {
                key: "crop_dilation",
                label: "Mask crop padding",
                value_type: "float",
                control: "slider",
                slider_display: "percent",
                min: 0,
                max: 0.5,
                step: 0.01,
              },
            ],
          },
        ],
      }),
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
    expect(screen.getByText("Mask crop mode")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("shows generation resolution only for workflows with aspect ratio processing", () => {
    useGenerationStore.setState({
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              stride: 16,
              search_steps: 2,
              resolutions: [480, 720],
              postprocess: {
                enabled: true,
                mode: "stretch_exact",
                apply_to: "all_visual_outputs",
              },
            },
            targets: [
              {
                width: {
                  node_id: "49",
                  param: "width",
                },
                height: {
                  node_id: "49",
                  param: "height",
                },
              },
            ],
            controls: [
              {
                key: "target_resolution",
                label: "Resolution",
                value_type: "int",
                options: [480, 720],
              },
            ],
          },
        ],
      }),
    });
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState(),
    );

    render(<GenerationPanel />);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Resolution")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Use exact input aspect ratio"),
    ).toBeInTheDocument();
  });

  it("routes unified resolution control changes through the store setter", () => {
    const setTargetResolution = vi.fn();
    useGenerationStore.setState({
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              stride: 16,
              search_steps: 2,
              resolutions: [480, 720],
              postprocess: {
                enabled: true,
                mode: "stretch_exact",
                apply_to: "all_visual_outputs",
              },
            },
            targets: [
              {
                width: {
                  node_id: "49",
                  param: "width",
                },
                height: {
                  node_id: "49",
                  param: "height",
                },
              },
            ],
            controls: [
              {
                key: "target_resolution",
                label: "Resolution",
                value_type: "int",
                options: [480, 720],
              },
            ],
          },
        ],
      }),
      setTargetResolution,
    });
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState(),
    );

    render(<GenerationPanel />);

    fireEvent.mouseDown(screen.getAllByRole("combobox")[2]!);
    fireEvent.click(screen.getByRole("option", { name: "720" }));

    expect(setTargetResolution).toHaveBeenCalledWith(720);
  });

  it("shows only postprocessed preview when replace mode has preview", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessedPreview: {
            previewUrl: "blob:postprocessed",
            mediaKind: "video",
            filename: "postprocessed.mp4",
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
        canInterruptCurrentGeneration: true,
        canClearQueuedGenerations: true,
        isPipelineInterruptible: true,
        pipelineStatusText: "Preparing asset",
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel current generation" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Clear queue" }),
    ).toBeEnabled();
    expect(screen.getByText("Preparing asset")).toBeInTheDocument();
  });

  it("routes current interrupt and clear-queue actions separately", () => {
    const handleInterruptCurrent = vi.fn();
    const handleClearQueue = vi.fn();
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        canGenerate: true,
        canInterruptCurrentGeneration: true,
        canClearQueuedGenerations: true,
        handleInterruptCurrent,
        handleClearQueue,
      }),
    );

    render(<GenerationPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel current generation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));

    expect(handleInterruptCurrent).toHaveBeenCalledTimes(1);
    expect(handleClearQueue).toHaveBeenCalledTimes(1);
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

  it("keeps generate available and shows rendering status during postprocess", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        isPostprocessing: true,
        postprocessingCount: 1,
        pipelineStatusText: "Rendering generation",
        canGenerate: true,
      }),
    );

    render(<GenerationPanel />);
    expect(
      screen.getByRole("button", { name: "Generate" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Cancel current generation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear queue" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Rendering generation")).toBeInTheDocument();
  });

  it("opens the queue menu and dispatches a preset count", () => {
    const handleGenerate = vi.fn();
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        canGenerate: true,
        handleGenerate,
      }),
    );

    render(<GenerationPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Queue multiple generations" }),
    );
    fireEvent.click(screen.getByText("x 4"));

    expect(handleGenerate).toHaveBeenCalledWith(4);
  });

  it("queues a custom generation count from the dialog", async () => {
    const handleGenerate = vi.fn();
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        canGenerate: true,
        handleGenerate,
      }),
    );

    render(<GenerationPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Queue multiple generations" }),
    );
    fireEvent.click(screen.getByText("Queue custom..."));
    fireEvent.change(await screen.findByLabelText("Generation count"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    expect(handleGenerate).toHaveBeenCalledWith(7);
  }, 10000);

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

  it("prefers imported asset preview over raw outputs when both exist", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessConfig: {
            mode: "auto",
            panel_preview: "raw_outputs",
            on_failure: "fallback_raw",
          },
        }),
        importedAssets: [
          {
            id: "asset-1",
            name: "imported-output.png",
            type: "image",
            src: "blob:imported-output",
            file: null,
            size: 123,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );

    render(<GenerationPanel />);
    expect(screen.getByText("Imported asset preview")).toBeInTheDocument();
    expect(screen.getByAltText("imported-output.png")).toBeInTheDocument();
    expect(screen.queryByText("Generated outputs")).not.toBeInTheDocument();
    expect(screen.queryByAltText("raw-output.png")).not.toBeInTheDocument();
  });

  it("shows a non-blocking stitch warning while preserving raw outputs", () => {
    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHookState({
        displayJob: makeCompletedJob({
          postprocessConfig: {
            mode: "stitch_frames_with_audio",
            panel_preview: "raw_outputs",
            on_failure: "fallback_raw",
          },
          postprocessError:
            "Postprocessing failed while stitching frames+audio: muxer exploded",
          postprocessedPreview: null,
        }),
      }),
    );

    render(<GenerationPanel />);
    expect(
      screen.getByText(
        "Warning: Postprocessing failed while stitching frames+audio: muxer exploded",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Generated outputs")).toBeInTheDocument();
    expect(screen.getByAltText("raw-output.png")).toBeInTheDocument();
  });

  it("shows imported asset preview when ingested assets exist", () => {
    const { container } = renderWithImportedVideoPreview();

    expect(screen.getByText("Imported asset preview")).toBeInTheDocument();
    expect(screen.getByText("stitched.mp4")).toBeInTheDocument();
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
            name: "clip.mp4",
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

  it("switches to manual mode, hides smart-only controls, and shows edit workflow", async () => {
    const setEditorOpen = vi.fn();
    useGenerationStore.setState({
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              stride: 16,
              search_steps: 2,
              resolutions: [480, 720],
              postprocess: {
                enabled: true,
                mode: "stretch_exact",
                apply_to: "all_visual_outputs",
              },
            },
            targets: [
              {
                width: {
                  node_id: "49",
                  param: "width",
                },
                height: {
                  node_id: "49",
                  param: "height",
                },
              },
            ],
            controls: [
              {
                key: "target_resolution",
                label: "Resolution",
                value_type: "int",
                options: [480, 720],
              },
            ],
          },
          {
            id: "mask_processing",
            kind: "mask_processing",
            controls: [
              {
                key: "crop_mode",
                label: "Mask crop mode",
                value_type: "enum",
                options: ["crop", "full"],
              },
              {
                key: "crop_dilation",
                label: "Mask crop padding",
                value_type: "float",
                control: "slider",
                slider_display: "percent",
                min: 0,
                max: 0.5,
                step: 0.01,
              },
            ],
          },
        ],
      }),
      derivedMaskMappings: [
        {
          sourceNodeId: "1",
          maskNodeId: "2",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      maskCropMode: "crop",
    });

    (useGenerationPanel as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (mode: "smart" | "manual" | undefined) =>
        makeHookState({
          setEditorOpen,
          workflowInputs: [
            {
              nodeId: "6",
              classType: "CLIPTextEncode",
              inputType: "text",
              param: "text",
              label: mode === "manual" ? "Manual Prompt" : "Prompt",
              currentValue: "",
              origin: mode === "manual" ? "inferred" : "rule",
            },
          ],
          widgetInputs:
            mode === "manual"
              ? [
                  {
                    nodeId: "145",
                    param: "seed",
                    currentValue: 123,
                    config: {
                      label: "Seed",
                      controlAfterGenerate: false,
                      valueType: "int",
                    },
                  },
                ]
              : [],
          canGenerate: true,
        }),
    );

    render(<GenerationPanel />);

    expect(screen.getByText("Resolution")).toBeInTheDocument();
    expect(screen.getByText("Mask crop mode")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("Mode"));
    fireEvent.click(screen.getByRole("option", { name: "Manual" }));

    expect(screen.queryByText("Resolution")).not.toBeInTheDocument();
    expect(screen.queryByText("Mask crop mode")).not.toBeInTheDocument();

    const editWorkflowButton = await screen.findByRole("button", {
      name: "Edit workflow",
    });
    fireEvent.click(editWorkflowButton);

    expect(setEditorOpen).toHaveBeenCalledWith(true);
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
            name: "stitched.mp4",
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
