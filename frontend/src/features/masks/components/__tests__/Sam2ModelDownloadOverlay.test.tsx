import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sam2ModelDownloadOverlay } from "../Sam2ModelDownloadOverlay";
import { getAvailableModels, subscribeToProgress } from "../../../../services/downloadApi";

vi.mock("../../../../services/downloadApi", () => ({
  getAvailableModels: vi.fn(),
  startModelDownload: vi.fn(),
  startModelDownloadBatch: vi.fn(),
  cancelDownload: vi.fn(),
  subscribeToProgress: vi.fn(),
}));

describe("Sam2ModelDownloadOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(subscribeToProgress).mockReturnValue(() => undefined);
  });

  it("notifies the parent when any SAM2 model is already installed", async () => {
    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [
        {
          key: "sam2.1_hiera_small",
          label: "SAM2.1 Small",
          description: "Faster",
          installed: true,
        },
        {
          key: "sam2.1_hiera_large",
          label: "SAM2.1 Large",
          description: "Higher quality",
          installed: false,
        },
      ],
    });

    const onModelsInstalled = vi.fn();
    render(<Sam2ModelDownloadOverlay onModelsInstalled={onModelsInstalled} />);

    await waitFor(() => {
      expect(onModelsInstalled).toHaveBeenCalledTimes(1);
    });
  });

  it("shows a download action for both SAM2 registry models when nothing is installed", async () => {
    vi.mocked(getAvailableModels).mockResolvedValue({
      sam2: [
        {
          key: "sam2.1_hiera_small",
          label: "SAM2.1 Small",
          description: "Faster, ~185 MB",
          installed: false,
        },
        {
          key: "sam2.1_hiera_large",
          label: "SAM2.1 Large",
          description: "Higher quality, ~900 MB",
          installed: false,
        },
      ],
    });

    render(<Sam2ModelDownloadOverlay onModelsInstalled={vi.fn()} />);

    await waitFor(() => {
      expect(getAvailableModels).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText("SAM2.1 Small")).toBeInTheDocument();
    expect(screen.getByText("Faster, ~185 MB")).toBeInTheDocument();
    expect(screen.getByText("SAM2.1 Large")).toBeInTheDocument();
    expect(screen.getByText("Higher quality, ~900 MB")).toBeInTheDocument();
    // 2 per-model "Download" buttons + 1 "Download all (2)" button
    expect(screen.getAllByRole("button", { name: /download/i })).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: /download all/i }),
    ).toBeInTheDocument();
  });

  it("does not notify the parent when no SAM2 models are installed", async () => {
    vi.mocked(getAvailableModels)
      .mockResolvedValue({
        sam2: [
          {
            key: "sam2.1_hiera_small",
            label: "SAM2.1 Small",
            description: "Faster",
            installed: false,
          },
          {
            key: "sam2.1_hiera_large",
            label: "SAM2.1 Large",
            description: "Higher quality",
            installed: false,
          },
        ],
      });

    const onModelsInstalled = vi.fn();
    render(<Sam2ModelDownloadOverlay onModelsInstalled={onModelsInstalled} />);

    await waitFor(() => {
      expect(getAvailableModels).toHaveBeenCalledTimes(1);
    });
    expect(onModelsInstalled).not.toHaveBeenCalled();
  });

  it("falls back to built-in SAM2 choices when the model request fails", async () => {
    vi.mocked(getAvailableModels).mockRejectedValue(
      new Error("Failed to fetch available models (500)"),
    );

    render(<Sam2ModelDownloadOverlay onModelsInstalled={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("SAM2.1 Small")).toBeInTheDocument();
    });

    expect(screen.getByText("SAM2.1 Large")).toBeInTheDocument();
    // 2 per-model "Download" buttons + 1 "Download all (2)" button
    expect(screen.getAllByRole("button", { name: /download/i })).toHaveLength(3);
    expect(
      screen.queryByText(/showing built-in download options/i),
    ).not.toBeInTheDocument();
  });
});
