// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ExtractDialog } from "../ExtractDialog";
import { useProjectStore } from "../../../project";
import type { ProjectOutputResolution } from "../../../project/outputResolutionOptions";

const MP4_FORMAT = {
  format: "mp4",
  extension: "mp4",
  mimeType: "video/mp4",
} as const;

describe("ExtractDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnExtractFrame = vi.fn();
  const mockOnExtractSelection = vi.fn();
  const mockOnExport = vi.fn();
  const mockOnSetView = vi.fn();

  const defaultProps = {
    open: true,
    dialogView: "choose" as const,
    onClose: mockOnClose,
    onExtractFrame: mockOnExtractFrame,
    onExtractSelection: mockOnExtractSelection,
    onExport: mockOnExport,
    onSetView: mockOnSetView,
    isProcessing: false,
    progress: 0,
  };

  const setProjectOutputResolution = (
    outputResolution: ProjectOutputResolution,
  ) => {
    useProjectStore.setState({
      config: { ...useProjectStore.getState().config, outputResolution },
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setProjectOutputResolution(1080);
  });

  describe("Choose view", () => {
    it("should render all three extraction options", () => {
      render(<ExtractDialog {...defaultProps} />);

      expect(screen.getByText("Extract Frame")).toBeInTheDocument();
      expect(screen.getByText("Extract Selection")).toBeInTheDocument();
      expect(screen.getByText("Export")).toBeInTheDocument();
    });

    it("should call onExtractFrame when frame option is clicked", () => {
      render(<ExtractDialog {...defaultProps} />);

      const frameButton = screen.getByText("Extract Frame").closest("button");
      fireEvent.click(frameButton!);

      expect(mockOnExtractFrame).toHaveBeenCalledTimes(1);
    });

    it("should call onExtractSelection when selection option is clicked", () => {
      render(<ExtractDialog {...defaultProps} />);

      const selectionButton = screen
        .getByText("Extract Selection")
        .closest("button");
      fireEvent.click(selectionButton!);

      expect(mockOnExtractSelection).toHaveBeenCalledTimes(1);
    });

    it("should call onSetView with export when export option is clicked", () => {
      render(<ExtractDialog {...defaultProps} />);

      const exportButton = screen.getByText(/^Export$/).closest("button");
      fireEvent.click(exportButton!);

      expect(mockOnSetView).toHaveBeenCalledWith("export");
    });

    it("should display cancel button", () => {
      render(<ExtractDialog {...defaultProps} />);

      const cancelButton = screen.getByText("Cancel");
      expect(cancelButton).toBeInTheDocument();

      fireEvent.click(cancelButton);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Export view", () => {
    it("should render resolution selector when not processing", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      expect(screen.getByText("Export Project")).toBeInTheDocument();
      expect(screen.getByLabelText("Resolution")).toBeInTheDocument();
    });

    it("should have default resolution of 1080p", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      const resolutionSelect = screen.getByLabelText("Resolution");
      expect(resolutionSelect).toHaveTextContent("1080p (FHD)");
    });

    it("should call onExport with selected resolution", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      // Find and click export button
      const exportButton = screen.getByRole("button", { name: /Export/i });
      fireEvent.click(exportButton);

      expect(mockOnExport).toHaveBeenCalledWith(1080, MP4_FORMAT);
    });

    it("should show progress bar when processing", () => {
      render(
        <ExtractDialog
          {...defaultProps}
          dialogView="export"
          isProcessing={true}
          progress={50}
        />,
      );

      expect(screen.getByText("Rendering... 50%")).toBeInTheDocument();
    });

    it("should disable close when processing", () => {
      render(
        <ExtractDialog
          {...defaultProps}
          dialogView="export"
          isProcessing={true}
          progress={50}
        />,
      );

      // Dialog should still have cancel button but onClose shouldn't be called on backdrop click
      const cancelButton = screen.getByRole("button", { name: /Cancel/i });
      expect(cancelButton).toBeInTheDocument();
    });

    it("should show back button when not processing", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      const backButton = screen.getByText("Back");
      fireEvent.click(backButton);

      expect(mockOnSetView).toHaveBeenCalledWith("choose");
    });
  });

  describe("Extracting frame view", () => {
    it("should show extracting message", () => {
      render(<ExtractDialog {...defaultProps} dialogView="extracting-frame" />);

      expect(screen.getByText("Extracting frame...")).toBeInTheDocument();
    });

    it("should not show any buttons during frame extraction", () => {
      render(<ExtractDialog {...defaultProps} dialogView="extracting-frame" />);

      expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
      expect(screen.queryByText("Back")).not.toBeInTheDocument();
    });
  });

  describe("Extracting selection view", () => {
    it("should show title and progress", () => {
      render(
        <ExtractDialog
          {...defaultProps}
          dialogView="extracting-selection"
          progress={75}
        />,
      );

      expect(screen.getByText("Extracting Selection")).toBeInTheDocument();
      expect(screen.getByText("Rendering... 75%")).toBeInTheDocument();
    });

    it("should show cancel button", () => {
      render(
        <ExtractDialog
          {...defaultProps}
          dialogView="extracting-selection"
          progress={50}
        />,
      );

      const cancelButton = screen.getByRole("button", { name: /Cancel/i });
      expect(cancelButton).toBeInTheDocument();

      fireEvent.click(cancelButton);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("should display progress as percentage", () => {
      render(
        <ExtractDialog
          {...defaultProps}
          dialogView="extracting-selection"
          progress={33.7}
        />,
      );

      expect(screen.getByText("Rendering... 34%")).toBeInTheDocument();
    });
  });

  describe("Dialog open/close", () => {
    it("should not render when open is false", () => {
      render(<ExtractDialog {...defaultProps} open={false} />);

      // MUI Dialog renders with display: none when closed
      // Check that Extract dialog title is not in the document in an accessible way
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("should render when open is true", () => {
      render(<ExtractDialog {...defaultProps} open={true} />);

      expect(screen.getByText("Extract")).toBeInTheDocument();
    });
  });

  describe("Resolution selection", () => {
    it("should allow selecting different resolutions", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      const resolutionSelect = screen.getByLabelText("Resolution");

      // Click to open the select
      fireEvent.mouseDown(resolutionSelect);

      // Select 4K option - use getAllByText as MUI renders in portal
      const option4K = screen.getAllByText("4K (UHD)")[0];
      fireEvent.click(option4K);

      // Click export with 4K selected
      const exportButton = screen.getByRole("button", { name: /Export/i });
      fireEvent.click(exportButton);

      expect(mockOnExport).toHaveBeenCalledWith(2160, MP4_FORMAT);
    });

    it("should have all resolution options available", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      const resolutionSelect = screen.getByLabelText("Resolution");
      fireEvent.mouseDown(resolutionSelect);

      // MUI renders options in portal, so we use queryAllByText and check length
      expect(screen.queryAllByText("480p (SD)").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("720p (HD)").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("1080p (FHD)").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("4K (UHD)").length).toBeGreaterThan(0);
    });
  });

  describe("Format selection", () => {
    it("reads export formats from the catalogue", () => {
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      const formatSelect = screen.getByLabelText("Format");
      expect(formatSelect).toHaveTextContent("MP4 (H.264/AAC)");
      fireEvent.mouseDown(formatSelect);
      fireEvent.click(screen.getByRole("option", { name: "WebM (VP9/Opus)" }));
      fireEvent.click(screen.getByRole("button", { name: /^Export$/i }));

      expect(mockOnExport).toHaveBeenCalledWith(1080, {
        format: "webm",
        extension: "webm",
        mimeType: "video/webm",
      });
    });
  });

  describe("Project output resolution", () => {
    it("seeds the dropdown from the project rather than a hard-coded 1080", () => {
      setProjectOutputResolution(720);
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      expect(screen.getByLabelText("Resolution")).toHaveTextContent(
        "720p (HD)",
      );
    });

    it("exports at the project resolution when the user does not override it", () => {
      setProjectOutputResolution(2160);
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      fireEvent.click(screen.getByRole("button", { name: /^Export$/i }));

      expect(mockOnExport).toHaveBeenCalledWith(2160, MP4_FORMAT);
    });

    it("keeps a per-export override that differs from the project", () => {
      setProjectOutputResolution(720);
      render(<ExtractDialog {...defaultProps} dialogView="export" />);

      fireEvent.mouseDown(screen.getByLabelText("Resolution"));
      fireEvent.click(screen.getByRole("option", { name: "480p (SD)" }));
      fireEvent.click(screen.getByRole("button", { name: /^Export$/i }));

      expect(mockOnExport).toHaveBeenCalledWith(480, MP4_FORMAT);
    });

    // Re-seeding on every project change would yank an override out from
    // under a user who is mid-dialog.
    it("does not overwrite an override while the dialog stays open", () => {
      setProjectOutputResolution(720);
      const { rerender } = render(
        <ExtractDialog {...defaultProps} dialogView="export" />,
      );

      fireEvent.mouseDown(screen.getByLabelText("Resolution"));
      fireEvent.click(screen.getByRole("option", { name: "480p (SD)" }));
      rerender(<ExtractDialog {...defaultProps} dialogView="export" />);

      expect(
        screen.getByRole("combobox", { name: "Resolution" }),
      ).toHaveTextContent("480p (SD)");
    });

    it("re-seeds from the project when the dialog is reopened", () => {
      setProjectOutputResolution(720);
      const { rerender } = render(
        <ExtractDialog {...defaultProps} dialogView="export" />,
      );

      fireEvent.mouseDown(screen.getByLabelText("Resolution"));
      fireEvent.click(screen.getByRole("option", { name: "480p (SD)" }));

      rerender(
        <ExtractDialog {...defaultProps} dialogView="export" open={false} />,
      );
      setProjectOutputResolution(2160);
      rerender(<ExtractDialog {...defaultProps} dialogView="export" />);

      expect(
        screen.getByRole("combobox", { name: "Resolution" }),
      ).toHaveTextContent("4K (UHD)");
    });
  });
});
