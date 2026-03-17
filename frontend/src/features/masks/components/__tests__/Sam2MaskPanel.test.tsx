import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sam2MaskPanel } from "../Sam2MaskPanel";

const defaultProps = {
  maskMode: "apply" as const,
  maskInverted: false,
  maskLabel: "Mask 1",
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
  onSetMaskMode: vi.fn(),
  onSetMaskInverted: vi.fn(),
};

describe("Sam2MaskPanel", () => {
  it("renders point counts", () => {
    expect(() => render(<Sam2MaskPanel {...defaultProps} />)).not.toThrow();
    expect(screen.getByText("Mask 1")).toBeInTheDocument();
    expect(screen.getByText(/Total: 0/)).toBeInTheDocument();
  });

  it("shows positive/negative counts and calls actions", () => {
    const onClearPoints = vi.fn();
    const onSetMaskMode = vi.fn();
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
        onSetMaskMode={onSetMaskMode}
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
    expect(onSetMaskMode).toHaveBeenCalledWith("preview");
    expect(onGenerateFramePreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Generate Mask Video" }));
    expect(onGenerateMask).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Inverted" }));
    expect(onSetMaskInverted).toHaveBeenCalledWith(true);
  });

  it("does not re-set preview mode when already previewing", () => {
    const onSetMaskMode = vi.fn();
    const onGenerateFramePreview = vi.fn();

    render(
      <Sam2MaskPanel
        {...defaultProps}
        maskMode="preview"
        points={[{ x: 0.2, y: 0.3, label: 1, timeTicks: 0 }]}
        onSetMaskMode={onSetMaskMode}
        onGenerateFramePreview={onGenerateFramePreview}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Generate Current Frame Preview" }),
    );

    expect(onSetMaskMode).not.toHaveBeenCalled();
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

    expect(screen.getAllByText("SAM2 models not found")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Generate Current Frame Preview" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Generate Mask Video" }),
    ).toBeDisabled();
  });
});
