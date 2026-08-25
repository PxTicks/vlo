import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sam2MaskPanel } from "../Sam2MaskPanel";

vi.mock("../Sam2ModelDownloadOverlay", () => ({
  Sam2ModelDownloadOverlay: ({
    onModelsInstalled,
  }: {
    onModelsInstalled: () => void;
  }) => (
    <button data-testid="sam2-download-overlay" onClick={onModelsInstalled}>
      Install SAM2
    </button>
  ),
}));

const defaultProps = {
  isPreviewing: false,
  maskInverted: false,
  maskLabel: "Mask 1",
  sam2PointMode: "add" as const,
  points: [],
  currentFramePointsCount: 0,
  isSam2Available: true,
  isSam2Checking: false,
  sam2AvailabilityError: null,
  onClearPoints: vi.fn(),
  onClearCurrentFramePoints: vi.fn(),
  onGenerateFramePreview: vi.fn(),
  isFrameGenerating: false,
  framePreviewError: null,
  onGenerateMask: vi.fn(),
  isGenerating: false,
  generateError: null,
  isDirty: true,
  hasMaskAsset: false,
  sam2GrowAmount: 0,
  onSetPreview: vi.fn(),
  onSetMaskInverted: vi.fn(),
  onSetSam2GrowAmount: vi.fn(),
  onSetSam2PointMode: vi.fn(),
  onModelsInstalled: vi.fn(),
};

describe("Sam2MaskPanel", () => {
  it("renders point counts", () => {
    expect(() => render(<Sam2MaskPanel {...defaultProps} />)).not.toThrow();
    expect(screen.getByText("Mask 1")).toBeInTheDocument();
    expect(screen.getByText(/Total: 0/)).toBeInTheDocument();
  });

  it("shows positive/negative counts and calls actions", () => {
    const onClearPoints = vi.fn();
    const onSetPreview = vi.fn();
    const onGenerateFramePreview = vi.fn();
    const onGenerateMask = vi.fn();
    const onSetMaskInverted = vi.fn();
    render(
      <Sam2MaskPanel
        {...defaultProps}
        points={[
          { x: 0.2, y: 0.3, label: 1, timeTicks: 0 },
          { x: 0.7, y: 0.6, label: 0, timeTicks: 0 },
        ]}
        currentFramePointsCount={2}
        onClearPoints={onClearPoints}
        onSetPreview={onSetPreview}
        onGenerateFramePreview={onGenerateFramePreview}
        onGenerateMask={onGenerateMask}
        onSetMaskInverted={onSetMaskInverted}
      />,
    );

    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByText(/Total: 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear All Points" }));
    expect(onClearPoints).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Generate Current Frame Preview" }),
    );
    expect(onSetPreview).toHaveBeenCalledWith(true);
    expect(onGenerateFramePreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Generate Mask Video" }));
    expect(onGenerateMask).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Inverted" }));
    expect(onSetMaskInverted).toHaveBeenCalledWith(true);
  });

  it("shows and updates the individual grow amount", () => {
    const onSetSam2GrowAmount = vi.fn();
    render(
      <Sam2MaskPanel
        {...defaultProps}
        sam2GrowAmount={12}
        onSetSam2GrowAmount={onSetSam2GrowAmount}
      />,
    );

    expect(screen.getByText("12px")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "SAM2 grow amount" }), {
      target: { value: "24" },
    });

    expect(onSetSam2GrowAmount).toHaveBeenCalledWith(24);
  });

  it("does not re-set preview mode when already previewing", () => {
    const onSetPreview = vi.fn();
    const onGenerateFramePreview = vi.fn();

    render(
      <Sam2MaskPanel
        {...defaultProps}
        isPreviewing
        points={[{ x: 0.2, y: 0.3, label: 1, timeTicks: 0 }]}
        onSetPreview={onSetPreview}
        onGenerateFramePreview={onGenerateFramePreview}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Generate Current Frame Preview" }),
    );

    expect(onSetPreview).not.toHaveBeenCalled();
    expect(onGenerateFramePreview).toHaveBeenCalledTimes(1);
  });

  it("shows Regenerate when mask asset exists and is dirty", () => {
    render(
      <Sam2MaskPanel
        {...defaultProps}
        points={[{ x: 0.2, y: 0.3, label: 1, timeTicks: 0 }]}
        isDirty={true}
        hasMaskAsset={true}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Regenerate Mask Video" }),
    ).toBeInTheDocument();
  });

  it("shows Generate when mask asset does not exist", () => {
    render(
      <Sam2MaskPanel
        {...defaultProps}
        points={[{ x: 0.2, y: 0.3, label: 1, timeTicks: 0 }]}
        isDirty={true}
        hasMaskAsset={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Generate Mask Video" }),
    ).toBeInTheDocument();
  });

  it("disables SAM2 actions and shows availability error when SAM2 is unavailable", () => {
    render(
      <Sam2MaskPanel
        {...defaultProps}
        isSam2Available={false}
        isSam2Checking={false}
        sam2AvailabilityError="SAM2 models not found"
        points={[{ x: 0.2, y: 0.3, label: 1, timeTicks: 0 }]}
      />,
    );

    expect(
      screen.getAllByText("SAM2 models not found").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("button", { name: "Generate Current Frame Preview" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Generate Mask Video" }),
    ).toBeDisabled();
  });

  it("shows model downloads when the checkpoints are the problem", () => {
    const onModelsInstalled = vi.fn();
    render(
      <Sam2MaskPanel
        {...defaultProps}
        isSam2Available={false}
        isSam2Checking={false}
        sam2AvailabilityFailure={{
          id: "model.checkpoint",
          status: "fail",
          stage: "discovered",
          code: "model_missing",
          summary: "No SAM2 checkpoints were found in the search paths",
        }}
        onModelsInstalled={onModelsInstalled}
      />,
    );

    fireEvent.click(screen.getByTestId("sam2-download-overlay"));

    expect(onModelsInstalled).toHaveBeenCalledTimes(1);
  });

  it("offers the install command instead of downloads when the package is missing", () => {
    // Downloading a checkpoint cannot install a Python package, and offering
    // it as the only recovery is what sent users in circles.
    render(
      <Sam2MaskPanel
        {...defaultProps}
        isSam2Available={false}
        isSam2Checking={false}
        sam2AvailabilityFailure={{
          id: "package.sam2",
          status: "fail",
          stage: "environment",
          code: "package_missing",
          summary: "The sam2 package is not installed",
          remediation: {
            kind: "command",
            summary: "Install SAM2 into the backend virtual environment",
            command: "uv pip install --python backend/.venv/bin/python -e backend/sam2",
            requiresRestart: true,
          },
        }}
      />,
    );

    expect(screen.queryByTestId("sam2-download-overlay")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "uv pip install --python backend/.venv/bin/python -e backend/sam2",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer downloads when the cause is unknown", () => {
    // No classified failure means the backend could not be reached, not that
    // a model is missing.
    render(
      <Sam2MaskPanel
        {...defaultProps}
        isSam2Available={false}
        isSam2Checking={false}
        sam2AvailabilityError="Failed to read runtime capabilities"
      />,
    );

    expect(screen.queryByTestId("sam2-download-overlay")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Failed to read runtime capabilities").length,
    ).toBeGreaterThan(0);
  });

  it("waits for the availability check before showing downloads", () => {
    render(
      <Sam2MaskPanel
        {...defaultProps}
        isSam2Available={false}
        isSam2Checking={true}
      />,
    );

    expect(screen.queryByTestId("sam2-download-overlay")).not.toBeInTheDocument();
    expect(
      screen.getByText("Checking SAM2 availability..."),
    ).toBeInTheDocument();
  });
});
