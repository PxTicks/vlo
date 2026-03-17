import { render, screen, fireEvent } from "@testing-library/react";
import { TransformationPanel } from "../TransformationPanel";
import { useTimelineStore } from "../../../timeline";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the store
vi.mock("../../../timeline/useTimelineStore");

describe("TransformationPanel", () => {
  const mockUpdateClipTransform = vi.fn();
  const mockAddClipTransform = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (state: {
      selectedClipIds: string[];
      clips: Array<{
        id: string;
        transformations: Array<{
          id: string;
          type: string;
          parameters: Record<string, unknown>;
        }>;
      }>;
      updateClipTransform: typeof mockUpdateClipTransform;
      addClipTransform: typeof mockAddClipTransform;
    }) => unknown) => {
      return selector({
        selectedClipIds: ["clip_1"],
        clips: [
          {
            id: "clip_1",
            transformations: [
              {
                id: "pos_1",
                type: "position",
                parameters: { x: 10, y: 20 },
              },
            ],
          },
        ],
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
      });
    });
  });

  it("renders transformation inputs when a clip is selected", () => {
    render(<TransformationPanel />);
    expect(screen.getByText("Layout")).toBeInTheDocument();
    
    // Position (Index 0 in BASE_GROUPS)
    const inputsX = screen.getAllByLabelText("X");
    expect(inputsX[0]).toHaveValue(10);
  });

  it("calls updateClipTransform when input changes and is committed (blurred)", () => {
    render(<TransformationPanel />);
    const inputsX = screen.getAllByLabelText("X");
    
    // Position X (Index 0)
    fireEvent.change(inputsX[0], { target: { value: "15" } });
    expect(mockUpdateClipTransform).not.toHaveBeenCalled();

    fireEvent.blur(inputsX[0]);
    expect(mockUpdateClipTransform).toHaveBeenCalledWith(
        "clip_1",
        "pos_1",
        expect.objectContaining({
            parameters: expect.objectContaining({ x: 15 })
        })
    );
  });


  it("renders the Add Transformation button and opens menu", () => {
    render(<TransformationPanel />);
    const addButton = screen.getByText("Add Transformation");
    expect(addButton).toBeInTheDocument();

    fireEvent.click(addButton);
    expect(screen.getByText("Color (HSL)")).toBeInTheDocument(); // Menu item from Registry
  });

  it("adds a new color transform when menu item is clicked", () => {
    render(<TransformationPanel />);
    
    // Open Menu
    fireEvent.click(screen.getByText("Add Transformation"));
    
    // Click Color (HSL)
    fireEvent.click(screen.getByText("Color (HSL)"));

    expect(mockAddClipTransform).toHaveBeenCalledWith(
        "clip_1",
        expect.objectContaining({
            type: "filter",
            filterName: "HslAdjustmentFilter",
            parameters: expect.objectContaining({ hue: 0, saturation: 0 }) // Default values from Registry
        })
    );
  });

  it("renders collapsible Base Layout and Dynamic sections", () => {
     // Setup store with a HSL transform
     (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
     ).mockImplementation((selector: (state: {
      selectedClipIds: string[];
      clips: Array<{
        id: string;
        transformations: Array<{
          id: string;
          type: string;
          filterName?: string;
          parameters: Record<string, unknown>;
        }>;
      }>;
      updateClipTransform: typeof mockUpdateClipTransform;
      addClipTransform: typeof mockAddClipTransform;
      removeClipTransform: typeof mockRemoveClipTransform;
    }) => unknown) => {
      return selector({
        selectedClipIds: ["clip_1"],
        clips: [
          {
            id: "clip_1",
            transformations: [
              { id: "pos_1", type: "position", parameters: { x: 0, y: 0 } },
              { 
                  id: "color_1", 
                  type: "filter", 
                  filterName: "HslAdjustmentFilter", 
                  parameters: { hue: 0 } 
              } 
            ],
          },
        ],
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
        removeClipTransform: mockRemoveClipTransform,
      });
    });

    // Mock removeClipTransform in the outer scope
    const mockRemoveClipTransform = vi.fn();
    // Re-mock to include removeClipTransform
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (state: {
      selectedClipIds: string[];
      clips: Array<{
        id: string;
        transformations: Array<{
          id: string;
          type: string;
          filterName?: string;
          parameters: Record<string, unknown>;
        }>;
      }>;
      updateClipTransform: typeof mockUpdateClipTransform;
      addClipTransform: typeof mockAddClipTransform;
      removeClipTransform: typeof mockRemoveClipTransform;
    }) => unknown) => {
        return selector({
            selectedClipIds: ["clip_1"],
            clips: [
            {
                id: "clip_1",
                transformations: [
                { id: "pos_1", type: "position", parameters: { x: 0, y: 0 } },
                { 
                    id: "color_1", 
                    type: "filter", 
                    filterName: "HslAdjustmentFilter",
                    parameters: { hue: 0 } 
                } 
                ],
            },
            ],
            updateClipTransform: mockUpdateClipTransform,
            addClipTransform: mockAddClipTransform,
            removeClipTransform: mockRemoveClipTransform,
        });
    });

    render(<TransformationPanel />);

    // Check for Collapsible Headers
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByText("Color (HSL)")).toBeInTheDocument();

    // Verify Expand/Collapse interactions (Layout)
    const layoutHeader = screen.getByText("Layout");
    fireEvent.click(layoutHeader); // Collapse
    fireEvent.click(layoutHeader); // Expand

    // Verify Remove Button for Dynamic Section
    // The "Color (HSL)" section should have a remove button. "Layout" should NOT.
    const removeButtons = screen.getAllByLabelText("Remove");
    expect(removeButtons).toHaveLength(1);
    
    fireEvent.click(removeButtons[0]);
    expect(mockRemoveClipTransform).toHaveBeenCalledWith("clip_1", "color_1");
  });
});
