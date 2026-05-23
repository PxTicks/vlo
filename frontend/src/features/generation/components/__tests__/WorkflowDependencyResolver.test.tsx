import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDependencyResolver } from "../WorkflowDependencyResolver";
import {
  getAvailableModels,
  startModelDownload,
  subscribeToProgress,
} from "../../../../services/downloadApi";

vi.mock("../../../../services/downloadApi", () => ({
  getAvailableModels: vi.fn(),
  startModelDownload: vi.fn(),
  startModelDownloadBatch: vi.fn(),
  cancelDownload: vi.fn(),
  subscribeToProgress: vi.fn(),
}));

describe("WorkflowDependencyResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(subscribeToProgress).mockReturnValue(() => undefined);
  });

  it("shows only the ComfyUI editor action when nodes are missing but models are not", () => {
    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: ["CustomNode"],
          missingModels: [],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /open comfyui editor/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
    expect(getAvailableModels).not.toHaveBeenCalled();
  });

  it("shows workflow download options for missing models", async () => {
    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:model.safetensors",
            label: "model.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "model.safetensors",
            directory: "checkpoints",
          },
          {
            key: "checkpoints:other.safetensors",
            label: "other.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "other.safetensors",
            directory: "checkpoints",
          },
        ],
      },
    });

    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["model.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("model.safetensors")).toBeInTheDocument();
    });

    expect(screen.queryByText("other.safetensors")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("falls back to the ComfyUI editor path when workflow download metadata is unavailable", async () => {
    vi.mocked(getAvailableModels).mockRejectedValue(
      new Error("Unable to load model download options"),
    );

    const onOpenEditor = vi.fn();
    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["model.safetensors"],
        }}
        onOpenEditor={onOpenEditor}
        onRefreshWarning={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getAvailableModels).toHaveBeenCalledWith({ workflowId: "wf.json" });
    });

    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open comfyui editor/i }));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
  });

  it("renders gated flux models with a license link and forwards the HF token", async () => {
    globalThis.localStorage.removeItem("vlo:hf-access-token");

    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "diffusion_models:flux-2-klein-base-9b-fp8.safetensors",
            label: "flux-2-klein-base-9b-fp8.safetensors",
            description: "Save to ComfyUI/models/diffusion_models",
            installed: false,
            filename: "flux-2-klein-base-9b-fp8.safetensors",
            directory: "diffusion_models",
            gated: true,
            gatedRepoUrl:
              "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8",
          },
        ],
      },
    });
    vi.mocked(startModelDownload).mockResolvedValue({
      jobId: "job-flux",
      label: "flux-2-klein-base-9b-fp8.safetensors",
      status: "pending",
    });

    render(
      <WorkflowDependencyResolver
        workflowId="vlo_klein_multi.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["flux-2-klein-base-9b-fp8.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    const licenseLink = await screen.findByRole("link", {
      name: /accept license on huggingface/i,
    });
    expect(licenseLink).toHaveAttribute(
      "href",
      "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8",
    );

    const disabledButton = await screen.findByRole("button", {
      name: /enter token to download/i,
    });
    expect(disabledButton).toBeDisabled();

    const tokenInput = screen.getByPlaceholderText("hf_...");
    fireEvent.change(tokenInput, { target: { value: "hf_abc123" } });

    const downloadButton = await screen.findByRole("button", { name: /^download$/i });
    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(startModelDownload).toHaveBeenCalledWith(
        "comfyui-workflow",
        "diffusion_models:flux-2-klein-base-9b-fp8.safetensors",
        {
          workflowId: "vlo_klein_multi.json",
          hfToken: "hf_abc123",
        },
      );
    });

    expect(globalThis.localStorage.getItem("vlo:hf-access-token")).toBe("hf_abc123");
    globalThis.localStorage.removeItem("vlo:hf-access-token");
  });

  it("starts a workflow-scoped download with the selected workflow id", async () => {
    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:model.safetensors",
            label: "model.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "model.safetensors",
            directory: "checkpoints",
          },
        ],
      },
    });
    vi.mocked(startModelDownload).mockResolvedValue({
      jobId: "job-1",
      label: "model.safetensors",
      status: "pending",
    });

    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["model.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    const downloadButton = await screen.findByRole("button", { name: /download/i });
    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(startModelDownload).toHaveBeenCalledWith(
        "comfyui-workflow",
        "checkpoints:model.safetensors",
        { workflowId: "wf.json" },
      );
    });
  });

  it("ignores stale model-option responses after switching workflows", async () => {
    type ResolveFn = (
      value: Awaited<ReturnType<typeof getAvailableModels>>,
    ) => void;
    const resolvers: { first: ResolveFn | null; second: ResolveFn | null } = {
      first: null,
      second: null,
    };

    vi.mocked(getAvailableModels)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvers.first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvers.second = resolve;
          }),
      );

    const { rerender } = render(
      <WorkflowDependencyResolver
        workflowId="ltx.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["ltx-model.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    rerender(
      <WorkflowDependencyResolver
        workflowId="wan.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["wan-model.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    resolvers.second?.({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:wan-model.safetensors",
            label: "wan-model.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "wan-model.safetensors",
            directory: "checkpoints",
          },
        ],
      },
    });

    expect(
      await screen.findByText("wan-model.safetensors"),
    ).toBeInTheDocument();

    resolvers.first?.({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:ltx-model.safetensors",
            label: "ltx-model.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "ltx-model.safetensors",
            directory: "checkpoints",
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.queryByText("ltx-model.safetensors")).not.toBeInTheDocument();
    });
  });

  it("queues every downloadable model in one batch request when Download all is clicked", async () => {
    const { startModelDownloadBatch } = await import(
      "../../../../services/downloadApi"
    );

    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:a.safetensors",
            label: "a.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "a.safetensors",
            directory: "checkpoints",
          },
          {
            key: "checkpoints:b.safetensors",
            label: "b.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "b.safetensors",
            directory: "checkpoints",
          },
        ],
      },
    });
    vi.mocked(startModelDownloadBatch).mockResolvedValue({
      jobs: [
        {
          modelKey: "checkpoints:a.safetensors",
          jobId: "job-a",
          label: "a.safetensors",
          status: "queued",
        },
        {
          modelKey: "checkpoints:b.safetensors",
          jobId: "job-b",
          label: "b.safetensors",
          status: "queued",
        },
      ],
      errors: [],
    });

    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["a.safetensors", "b.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    const downloadAll = await screen.findByRole("button", {
      name: /download all \(2\)/i,
    });
    fireEvent.click(downloadAll);

    await waitFor(() => {
      expect(startModelDownloadBatch).toHaveBeenCalledWith(
        "comfyui-workflow",
        ["checkpoints:a.safetensors", "checkpoints:b.safetensors"],
        { workflowId: "wf.json" },
      );
    });
    // Per-row "Download" should not have been called — the batch endpoint
    // owns the queue server-side.
    expect(startModelDownload).not.toHaveBeenCalled();
  });

  it("adopts an in-flight job started by another workflow so its progress shows here", async () => {
    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [],
      comfyui: {
        modelDownloadsEnabled: true,
        workflowModels: [
          {
            key: "checkpoints:shared.safetensors",
            label: "shared.safetensors",
            description: "Save to ComfyUI/models/checkpoints",
            installed: false,
            filename: "shared.safetensors",
            directory: "checkpoints",
            activeJobId: "job-from-other-tab",
          },
        ],
      },
    });

    render(
      <WorkflowDependencyResolver
        workflowId="wf.json"
        warning={{
          missingNodeTypes: [],
          missingModels: ["shared.safetensors"],
        }}
        onOpenEditor={vi.fn()}
        onRefreshWarning={vi.fn()}
      />,
    );

    await waitFor(() => {
      // The first arg to subscribeToProgress is the jobId we adopted.
      expect(subscribeToProgress).toHaveBeenCalledWith(
        "job-from-other-tab",
        expect.any(Function),
        expect.any(Function),
      );
    });
  });
});
