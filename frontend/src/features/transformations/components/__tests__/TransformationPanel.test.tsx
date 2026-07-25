import { render, screen, fireEvent } from "@testing-library/react";
import { EffectsPanel } from "../EffectsPanel";
import { TransformationPanel } from "../TransformationPanel";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { extensionTransformationRegistry } from "../../extensions/ExtensionTransformationRegistry";
import { extensionEntityProviderRegistry } from "../../../extensions/entities/publicApi";
import { Container } from "pixi.js";

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
  const tracks = [
    {
      id: "track_1",
      label: "Track 1",
      isVisible: true,
      isLocked: false,
      isMuted: false,
      type: "visual",
    },
  ];

  function installTimelineState<T extends {
    selectedClipIds: string[];
    clips: unknown[];
  }>(state: T): void {
    const stateWithTracks = { tracks, ...state };
    const mockedStore = useTimelineStore as unknown as ReturnType<
      typeof vi.fn
    > & {
      getState: ReturnType<typeof vi.fn>;
    };
    mockedStore.mockImplementation(
      (selector: (store: typeof stateWithTracks) => unknown) =>
        selector(stateWithTracks),
    );
    mockedStore.getState = vi.fn(() => stateWithTracks);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    installTimelineState({
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

  it("renders transformation inputs when a clip is selected", () => {
    render(<TransformationPanel />);
    expect(screen.getByRole("tab", { name: "Display" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual([
      "Display",
      "Speed",
      "Audio",
      "Color",
    ]);
    expect(screen.getByRole("tabpanel", { name: "Display" })).toBeInTheDocument();

    // Position (Index 0 in BASE_GROUPS)
    const inputsX = screen.getAllByLabelText("X");
    expect(inputsX[0]).toHaveValue(10);
  });

  it("routes controls through the transformation subtabs", () => {
    installTimelineState({
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
            {
              id: "grade-1",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    });

    render(<TransformationPanel />);

    expect(
      screen.queryByRole("heading", { name: "Speed Adjustment" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Speed" }));
    expect(
      screen.getByRole("heading", { name: "Speed Adjustment" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
    expect(screen.getByRole("tabpanel", { name: "Audio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Audio" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Color" }));
    expect(screen.getByText("Color Grade")).toBeInTheDocument();
  });

  it("keeps the complete color grade in Color Grading", () => {
    installTimelineState({
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          transformations: [
            {
              id: "hsl-1",
              type: "filter",
              filterName: "HslAdjustmentFilter",
              isEnabled: true,
              parameters: { hue: 0 },
            },
            {
              id: "grade-1",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    });

    render(<TransformationPanel />);

    expect(screen.queryByText("Color (HSL)")).not.toBeInTheDocument();
    expect(screen.queryByText("Color Grade")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Color" }));

    expect(screen.getByText("Color Grade")).toBeInTheDocument();
    expect(screen.queryByText("Color (HSL)")).not.toBeInTheDocument();
  });

  it("chains another color grade after the last one in the panel", () => {
    installTimelineState({
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          transformations: [
            {
              id: "grade-1",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
            {
              id: "hsl-1",
              type: "filter",
              filterName: "HslAdjustmentFilter",
              isEnabled: true,
              parameters: { hue: 0 },
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    });

    render(<TransformationPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Color" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Color Grade" }));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    expect(
      (nextTransforms as { id: string; filterName?: string }[]).map(
        (transform) => transform.filterName,
      ),
    ).toEqual([
      "ColorGradeFilter",
      "ColorGradeFilter",
      "HslAdjustmentFilter",
    ]);
    expect((nextTransforms as { id: string }[])[1].id).not.toBe("grade-1");
  });

  it("numbers chained grades and lets the added ones be removed", () => {
    installTimelineState({
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          transformations: [
            {
              id: "grade-1",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
            {
              id: "grade-2",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    });

    render(<TransformationPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Color" }));

    expect(screen.getByText("Color Grade 1")).toBeInTheDocument();
    expect(screen.getByText("Color Grade 2")).toBeInTheDocument();
    // One panel-level action, not one per grade section.
    expect(
      screen.getAllByRole("button", { name: "Add Color Grade" }),
    ).toHaveLength(1);

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1]);

    expect(mockSetClipTransforms).toHaveBeenCalledWith("clip_1", [
      expect.objectContaining({ id: "grade-1" }),
    ]);
  });

  it("materializes the built-in color grade when its tab is opened", () => {
    render(<TransformationPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Color" }));

    expect(mockSetClipTransforms).toHaveBeenCalledWith(
      "clip_1",
      expect.arrayContaining([
        expect.objectContaining({
          type: "filter",
          filterName: "ColorGradeFilter",
          isEnabled: true,
        }),
      ]),
    );
  });

  it("gates added visual transformations from audio clips", () => {
    installTimelineState({
      selectedClipIds: ["clip_1"],
      clips: [
        {
          ...baseClip,
          type: "audio",
          transformations: [
            {
              id: "hsl-1",
              type: "filter",
              filterName: "HslAdjustmentFilter",
              isEnabled: true,
              parameters: { hue: 0 },
            },
            {
              id: "grade-1",
              type: "filter",
              filterName: "ColorGradeFilter",
              isEnabled: true,
              parameters: {},
            },
          ],
        },
      ],
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    });

    render(<TransformationPanel />);

    expect(screen.queryByText("Color (HSL)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Color" }));
    expect(
      screen.getByText("No color grading transformations have been added."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
    expect(screen.getByRole("heading", { name: "Audio" })).toBeInTheDocument();
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
    installTimelineState(state);

    render(<TransformationPanel />);

    expect(
      screen.getByTestId("extension-inspector-placeholder"),
    ).toHaveTextContent(
      "Missing extension provider example.shapes/star. Its data is preserved.",
    );
  });

  it("renders trusted entity property UI in the host inspector slot", () => {
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
    installTimelineState(state);
    const registration = extensionEntityProviderRegistry
      .bind({
        extension: { id: "example.shapes", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "star",
        apiVersion: 1,
        kind: "trusted-pixi",
        label: "Star",
        schemaVersion: 1,
        defaultPayload: { points: 5 },
        validate: () => undefined,
        createRenderable: () => ({
          object: new Container(),
          update: () => undefined,
        }),
        inspector: (props) => <div>Star points: {String(props.data)}</div>,
      });

    try {
      render(<TransformationPanel />);

      expect(
        screen.getByTestId(
          "extension-entity-inspector-example.shapes/star",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("extension-inspector-placeholder")).toBeNull();
    } finally {
      registration.dispose();
    }
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


  it("does not offer a second transformation add surface", () => {
    render(<TransformationPanel />);
    expect(screen.queryByText("Add Transformation")).not.toBeInTheDocument();
  });

  it("shows a registered added extension transformation in Effects", () => {
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
      installTimelineState({
        selectedClipIds: ["clip_1"],
        clips: [
          {
            ...baseClip,
            transformations: [
              {
                id: "extension-grade",
                type: "filter",
                filterName: "example.color-grade/film-grade",
                isEnabled: true,
                parameters: { hue: 0 },
              },
            ],
          },
        ],
        setClipTransforms: mockSetClipTransforms,
        setClipTransformsAndShape: mockSetClipTransformsAndShape,
        setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
        updateClipMask: mockUpdateClipMask,
      });
      render(<EffectsPanel />);
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
    installTimelineState(state);

    render(<EffectsPanel />);

    expect(
      screen.getByTestId("missing-extension-transformation"),
    ).toHaveTextContent(
      "Missing transformation example.missing/film-grade. Its parameters are preserved.",
    );
  });

  it("renders added effects as removable sections in Effects", () => {
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

    installTimelineState(state);

    render(<EffectsPanel />);

    expect(screen.queryByRole("tab", { name: "Display" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Display" })).not.toBeInTheDocument();
    expect(screen.getByText("Color (HSL)")).toBeInTheDocument();

    // Verify Remove Button for Dynamic Section
    // Added effects remain removable from their dedicated inspector.
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
