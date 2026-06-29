import { render, screen, fireEvent } from "@testing-library/react";
import { TransformationPanel } from "../TransformationPanel";
import { useTimelineStore } from "../../../timeline";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { extensionTransformationRegistry } from "../../extensions/ExtensionTransformationRegistry";

// Mock the store
vi.mock("../../../timeline/useTimelineStore");

describe("TransformationPanel", () => {
  const mockSetClipTransforms = vi.fn();
  const mockSetClipTransformsAndShape = vi.fn();
  const mockSetClipMaskCompositeTransforms = vi.fn();
  const mockUpdateClipMask = vi.fn();
  const baseClip = {
    id: "clip_1",
    trackId: "track_1",
    start: 0,
    timelineDuration: 10_000,
    offset: 0,
    type: "video",
    croppedSourceDuration: 10_000,
    name: "Clip 1",
    assetId: "asset_1",
    sourceDuration: 10_000,
    transformedDuration: 10_000,
    transformedOffset: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (state: {
      selectedClipIds: string[];
      clips: Array<{
        id: string;
        trackId: string;
        start: number;
        timelineDuration: number;
        offset: number;
        type: string;
        croppedSourceDuration: number;
        name: string;
        assetId: string;
        sourceDuration: number;
        transformedDuration: number;
        transformedOffset: number;
        transformations: Array<{
          id: string;
          type: string;
          isEnabled: boolean;
          parameters: Record<string, unknown>;
        }>;
      }>;
      setClipTransforms: typeof mockSetClipTransforms;
      setClipTransformsAndShape: typeof mockSetClipTransformsAndShape;
      setClipMaskCompositeTransforms: typeof mockSetClipMaskCompositeTransforms;
      updateClipMask: typeof mockUpdateClipMask;
    }) => unknown) => {
      return selector({
        selectedClipIds: ["clip_1"],
        clips: [
          {
            ...baseClip,
            transformations: [
              {
                id: "pos_1",
                type: "position",
                isEnabled: true,
                parameters: { x: 10, y: 20 },
              },
            ],
          },
        ],
        setClipTransforms: mockSetClipTransforms,
        setClipTransformsAndShape: mockSetClipTransformsAndShape,
        setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
        updateClipMask: mockUpdateClipMask,
      });
    });
  });

  it("renders transformation inputs when a clip is selected", () => {
    render(<TransformationPanel />);
    expect(screen.getByText("Display")).toBeInTheDocument();

    // Position (Index 0 in BASE_GROUPS)
    const inputsX = screen.getAllByLabelText("X");
    expect(inputsX[0]).toHaveValue(10);
  });

  it("shows a payload-preserving placeholder for a missing extension provider", () => {
    const state = {
      selectedClipIds: ["extension_1"],
      clips: [
        {
          ...baseClip,
          id: "extension_1",
          type: "extension",
          transformations: [],
          extensionPayload: {
            extensionId: "example.shapes",
            typeId: "star",
            schemaVersion: 1,
            data: { points: 5 },
          },
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    };
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (store: typeof state) => unknown) =>
      selector(state),
    );

    render(<TransformationPanel />);

    expect(
      screen.getByTestId("extension-inspector-placeholder"),
    ).toHaveTextContent(
      "Missing extension provider example.shapes/star. Its data is preserved.",
    );
  });

  it("calls updateClipTransform when input changes and is committed (blurred)", () => {
    render(<TransformationPanel />);
    const inputsX = screen.getAllByLabelText("X");
    
    // Position X (Index 0)
    fireEvent.change(inputsX[0], { target: { value: "15" } });
    expect(mockSetClipTransforms).not.toHaveBeenCalled();

    fireEvent.blur(inputsX[0]);
    expect(mockSetClipTransforms).toHaveBeenCalledWith(
      "clip_1",
      [
        expect.objectContaining({
          id: "pos_1",
          parameters: expect.objectContaining({ x: 15 }),
        }),
      ],
    );
  });


  it("renders the Add Transformation button and opens menu", () => {
    render(<TransformationPanel />);
    const addButton = screen.getByText("Add Transformation");
    expect(addButton).toBeInTheDocument();

    fireEvent.click(addButton);
    expect(screen.getByText("Color (HSL)")).toBeInTheDocument(); // Menu item from Registry
  });

  it("shows a registered extension transformation in the Add menu", () => {
    const registration = extensionTransformationRegistry
      .bind({
        extension: { id: "example.color-grade", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "film-grade",
        apiVersion: 1,
        kind: "host-filter",
        hostFilter: "hsl-adjustment",
        label: "Extension Film Grade",
        groups: [
          {
            id: "grade",
            title: "Grade",
            controls: [
              {
                type: "slider",
                name: "hue",
                label: "Hue",
                defaultValue: 0,
                min: -180,
                max: 180,
              },
            ],
          },
        ],
      });

    try {
      render(<TransformationPanel />);
      fireEvent.click(screen.getByText("Add Transformation"));
      expect(screen.getByText("Extension Film Grade")).toBeInTheDocument();
    } finally {
      registration.dispose();
    }
  });

  it("preserves and labels a transformation whose extension is missing", () => {
    const state = {
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          transformations: [
            {
              id: "missing-grade",
              type: "filter",
              filterName: "example.missing/film-grade",
              isEnabled: true,
              parameters: { gamma: 1.2 },
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    };
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (store: typeof state) => unknown) =>
      selector(state),
    );

    render(<TransformationPanel />);

    expect(
      screen.getByTestId("missing-extension-transformation"),
    ).toHaveTextContent(
      "Missing transformation example.missing/film-grade. Its parameters are preserved.",
    );
  });

  it("adds a new color transform when menu item is clicked", () => {
    render(<TransformationPanel />);
    
    // Open Menu
    fireEvent.click(screen.getByText("Add Transformation"));
    
    // Click Color (HSL)
    fireEvent.click(screen.getByText("Color (HSL)"));

    expect(mockSetClipTransforms).toHaveBeenCalledWith(
      "clip_1",
      expect.arrayContaining([
        expect.objectContaining({ id: "pos_1", type: "position" }),
        expect.objectContaining({
          type: "filter",
          filterName: "HslAdjustmentFilter",
          parameters: expect.objectContaining({ hue: 0, saturation: 0 }),
        }),
      ]),
    );
  });

  it("renders collapsible Base Layout and Dynamic sections", () => {
    // Hoist the state so every useTimelineStore() call returns the same
    // references. Otherwise useShallow() in useTransformationController
    // sees new references each render — combined with the dnd-kit state
    // update from registering SortableTransformationItem, this loops until
    // the test times out.
    const state = {
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          transformations: [
            {
              id: "pos_1",
              type: "position",
              isEnabled: true,
              parameters: { x: 0, y: 0 },
            },
            {
              id: "color_1",
              type: "filter",
              isEnabled: true,
              filterName: "HslAdjustmentFilter",
              parameters: { hue: 0 },
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    };

    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (s: typeof state) => unknown) =>
      selector(state),
    );

    render(<TransformationPanel />);

    // Check for Collapsible Headers
    expect(screen.getByText("Display")).toBeInTheDocument();
    expect(screen.getByText("Color (HSL)")).toBeInTheDocument();

    // Verify Expand/Collapse interactions (Display)
    const layoutHeader = screen.getByText("Display");
    fireEvent.click(layoutHeader); // Collapse
    fireEvent.click(layoutHeader); // Expand

    // Verify Remove Button for Dynamic Section
    // The "Color (HSL)" section should have a remove button. "Display" should NOT.
    const removeButtons = screen.getAllByLabelText("Remove");
    expect(removeButtons).toHaveLength(1);
    
    fireEvent.click(removeButtons[0]);
    expect(mockSetClipTransforms).toHaveBeenCalledWith(
      "clip_1",
      [
        expect.objectContaining({ id: "pos_1", type: "position" }),
      ],
    );
  });
});
