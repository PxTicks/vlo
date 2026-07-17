import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimelineClipItem } from "../TimelineClip";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../../hooks/useInteractionStore";
import { useCompositeTimelineStore } from "../../../composite/useCompositeTimelineStore";
import { useCompositeLibraryStore } from "../../../composite/useCompositeLibraryStore";
import { useTimelineKeyframeClipOverlay } from "../../../transformations/hooks/useTimelineKeyframeClipOverlay";
import { getDefaultSectionId } from "../../../transformations/utils/sectionKeyframes";
import { useTransformationViewStore } from "../../../transformations/store/useTransformationViewStore";
import type { Asset } from "../../../../types/Asset";
import type {
  BaseClip,
  TimelineClip as TimelineClipType,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { TimelineClipOverlayDefinition } from "../../clipOverlayApi";
import {
  createEndpointOverlayItem,
  createSourceTimeOverlayItem,
} from "../../clipOverlayApi";
import {
  PIXELS_PER_SECOND,
  TICKS_PER_SECOND,
  TRACK_HEADER_WIDTH,
} from "../../constants";
import { extensionPayloadProviderRegistry } from "../../../extensions/persistence/publicApi";
import { extensionEntityProviderRegistry } from "../../../extensions/entities/publicApi";
import { Container } from "pixi.js";

// --- MOCKS ---

const viewStoreState = vi.hoisted(() => ({
  zoomScale: 1,
}));
const extractionState = vi.hoisted(() => ({
  mockUseAsset: vi.fn(),
  mockExtractTimelineClipAudioAsset: vi.fn(),
  mockRevealAssetInBrowser: vi.fn(),
  mockOpenSamAudioExtractDialog: vi.fn(),
  mockThumbnailCanvas: vi.fn(),
}));

// Mock dnd-kit hooks to prevent errors during render
vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
    transform: null,
  }),
}));

// Mock the canvas component to avoid canvas context errors
vi.mock("../ThumbnailCanvas", () => ({
  ThumbnailCanvas: (props: unknown) => {
    extractionState.mockThumbnailCanvas(props);
    return <div data-testid="thumbnail-canvas" />;
  },
}));

// Mock View Store for zoom/pixel conversion
vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        zoomScale: viewStoreState.zoomScale,
        ticksToPx: (ticks: number) =>
          (ticks / TICKS_PER_SECOND) *
          PIXELS_PER_SECOND *
          viewStoreState.zoomScale,
        pxToTicks: (pixels: number) =>
          Math.round(
            (pixels /
              (PIXELS_PER_SECOND * Math.max(0.001, viewStoreState.zoomScale))) *
              TICKS_PER_SECOND,
          ),
        setZoomScale: vi.fn(),
        setScrollContainer: vi.fn(),
        scrollContainer: null,
      }),
    {
      getState: () => ({
        zoomScale: viewStoreState.zoomScale,
        ticksToPx: (ticks: number) =>
          (ticks / TICKS_PER_SECOND) *
          PIXELS_PER_SECOND *
          viewStoreState.zoomScale,
        pxToTicks: (pixels: number) =>
          Math.round(
            (pixels /
              (PIXELS_PER_SECOND * Math.max(0.001, viewStoreState.zoomScale))) *
              TICKS_PER_SECOND,
          ),
        setZoomScale: vi.fn(),
        setScrollContainer: vi.fn(),
        scrollContainer: null,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock("../../../userAssets/api", () => ({
  useAsset: extractionState.mockUseAsset,
}));

vi.mock("../../utils/clipAudioExtraction", () => ({
  extractTimelineClipAudioAsset:
    extractionState.mockExtractTimelineClipAudioAsset,
}));

vi.mock("../../../userAssets/useAssetBrowserRevealStore", () => ({
  revealAssetInBrowser: extractionState.mockRevealAssetInBrowser,
}));

vi.mock("../../../samAudio", () => ({
  useSamAudioExtractDialogStore: Object.assign(
    () => extractionState.mockOpenSamAudioExtractDialog,
    {
      getState: () => ({
        openForClip: extractionState.mockOpenSamAudioExtractDialog,
      }),
    },
  ),
}));

describe("TimelineClip Visual Geometry", () => {
  const mockClip: TimelineClipType = {
    id: "clip_1",
    trackId: "track_1",
    start: 100,
    timelineDuration: 200,
    type: "video",
    name: "Test Clip",
    assetId: "asset-1",
    transformations: [],
    offset: 0,
    sourceDuration: 200,
    transformedDuration: 200,
    transformedOffset: 0,
    croppedSourceDuration: 200,
  };

  function createOverlay(
    definitionId: string,
    items: ReturnType<TimelineClipOverlayDefinition["useItems"]>,
  ): TimelineClipOverlayDefinition {
    return {
      id: definitionId,
      useItems: () => items,
    };
  }

  function TimelineClipWithKeyframeOverlay({
    clip,
    presentation,
  }: {
    clip: TimelineClipType;
    presentation?: ComponentProps<typeof TimelineClipItem>["presentation"];
  }) {
    const keyframeOverlay = useTimelineKeyframeClipOverlay();
    return (
      <TimelineClipItem
        clip={clip}
        presentation={presentation}
        clipOverlays={[keyframeOverlay]}
      />
    );
  }

  beforeEach(() => {
    // Reset stores
    viewStoreState.zoomScale = 1;
    useTimelineStore.setState({
      selectedClipIds: [],
      tracks: [{ id: "track_1", label: "Track 1" } as unknown as TimelineTrack],
    });
    useTimelineStore.getState().setTimelinePersistenceSuspended(false);
    useCompositeTimelineStore.setState({
      stack: [],
      isBusy: false,
      lastError: null,
    });
    useCompositeLibraryStore.setState({
      composites: [],
      selectedCompositeIds: [],
      revealRequest: null,
      isLoading: false,
    });
    useTransformationViewStore.setState({
      activeSection: null,
      activeSpline: null,
    });
    useInteractionStore.setState({ activeId: null, operation: null });
    extractionState.mockUseAsset.mockReset();
    extractionState.mockUseAsset.mockImplementation(
      (assetId: string | null | undefined) =>
        assetId
          ? ({
              id: assetId,
              hasAudio: true,
            } as Asset)
          : undefined,
    );
    extractionState.mockExtractTimelineClipAudioAsset.mockReset();
    extractionState.mockExtractTimelineClipAudioAsset.mockResolvedValue(null);
    extractionState.mockRevealAssetInBrowser.mockReset();
    extractionState.mockOpenSamAudioExtractDialog.mockReset();
    extractionState.mockThumbnailCanvas.mockReset();

    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
  });

  it("REGRESSION: Renders with strict 0px offset when in Overlay mode", () => {
    // This guards against the 'Ghost Offset' bug where the header width
    // was accidentally applied to the drag overlay.

    render(<TimelineClipItem clip={mockClip} isOverlay={true} />);

    const clipElement = screen.getByTestId("timeline-clip");

    // 1. Must NOT rely on calculation
    expect(clipElement.style.left).toBe("0px");

    // 2. Must NOT contain the header width variable or constant
    expect(clipElement.style.left).not.toContain(`${TRACK_HEADER_WIDTH}px`);
  });

  it("REGRESSION: Renders with robust calc() formula in Standard mode", () => {
    // This guards against the 'Resize Flush Left' bug.
    // We ensure the clip is anchored to the Header Width and Zoom.

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    const clipElement = screen.getByTestId("timeline-clip");

    // The raw inline style should contain our robust formula
    const inlineLeft = clipElement.style.left;

    // 1. Must anchor to Header Width
    expect(inlineLeft).toContain(`${TRACK_HEADER_WIDTH}px`);

    // 2. Must scale with Zoom
    expect(inlineLeft).toContain("var(--timeline-zoom, 1)");

    // 3. Must include the delta variable for hardware-accelerated resizing
    expect(inlineLeft).toContain("var(--drag-delta-x, 0px)");
  });

  it("uses the default cursor for draggable clips", () => {
    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    expect(screen.getByTestId("timeline-clip").style.cursor).toBe("default");
  });

  it("opens the placement-owned composite editor from the clip button", () => {
    const compositeClip: TimelineClipType = {
      id: "composite_1",
      trackId: "track_1",
      start: 100,
      timelineDuration: 200,
      type: "video",
      name: "Nested Scene",
      assetId: "proxy-asset-1",
      compositeId: "composite-asset-1",
      transformations: [],
      offset: 0,
      sourceDuration: 200,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 200,
    };
    useTimelineStore.setState({
      clips: [compositeClip],
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    });
    useCompositeLibraryStore.setState({
      composites: [
        {
          id: compositeClip.compositeId!,
          name: "Nested Scene",
          content: {
            durationTicks: 200,
            clips: [],
            tracks: [],
          },
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    render(<TimelineClipItem clip={compositeClip} isOverlay={false} />);

    const openButton = screen.getByTestId("timeline-clip-composite-open");
    expect(openButton).toHaveTextContent("Composite");
    fireEvent.click(openButton);

    expect(useCompositeTimelineStore.getState().stack).toEqual([
      expect.objectContaining({
        ownerCompositeAssetId: compositeClip.compositeId,
        ownerClipId: compositeClip.id,
      }),
    ]);
    expect(useTimelineStore.getState().clips).toEqual([]);
  });

  it("renders composite thumbnails through the normal thumbnail canvas", () => {
    const compositeClip: TimelineClipType = {
      id: "composite_1",
      trackId: "track_1",
      start: 100,
      timelineDuration: 200,
      type: "video",
      name: "Nested Scene",
      assetId: "proxy-asset-1",
      compositeId: "composite-asset-1",
      transformations: [],
      offset: 0,
      sourceDuration: 200,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 200,
    };
    useTimelineStore.setState({
      clips: [compositeClip],
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    });

    render(<TimelineClipItem clip={compositeClip} isOverlay={false} />);

    expect(screen.getByTestId("thumbnail-canvas")).toBeInTheDocument();
    expect(extractionState.mockThumbnailCanvas).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: expect.objectContaining({
          id: compositeClip.id,
          type: "video",
          assetId: "proxy-asset-1",
        }),
      }),
    );
  });

  it("renders an unknown extension entity as a missing-provider placeholder", () => {
    const extensionClip: TimelineClipType = {
      id: "extension_1",
      trackId: "track_1",
      start: 100,
      timelineDuration: 200,
      type: "extension",
      name: "Procedural star",
      transformations: [],
      offset: 0,
      sourceDuration: null,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 200,
      extensionPayload: {
        extensionId: "example.shapes",
        typeId: "star",
        schemaVersion: 1,
        data: { points: 5 },
      },
    };
    useTimelineStore.setState({ clips: [extensionClip] });

    render(<TimelineClipItem clip={extensionClip} isOverlay={false} />);

    expect(
      screen.getByTestId("timeline-clip-missing-extension-label"),
    ).toHaveTextContent("Missing · example.shapes/star");
    expect(screen.getByTestId("timeline-clip")).toHaveAttribute(
      "data-extension-provider",
      "missing",
    );
    expect(screen.getByText("Procedural star")).toBeInTheDocument();
    expect(screen.queryByTestId("thumbnail-canvas")).not.toBeInTheDocument();
  });

  it("distinguishes an active payload provider from a missing extension", () => {
    const registration = extensionPayloadProviderRegistry
      .bind({
        extension: { id: "example.shapes", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "star",
        apiVersion: 1,
        schemaVersion: 1,
        validate: () => undefined,
      });
    const extensionClip: TimelineClipType = {
      id: "extension_registered",
      trackId: "track_1",
      start: 0,
      timelineDuration: 100,
      type: "extension",
      name: "Registered star",
      transformations: [],
      offset: 0,
      sourceDuration: null,
      transformedDuration: 100,
      transformedOffset: 0,
      croppedSourceDuration: 100,
      extensionPayload: {
        extensionId: "example.shapes",
        typeId: "star",
        schemaVersion: 1,
        data: { points: 5 },
      },
    };

    try {
      render(<TimelineClipItem clip={extensionClip} isOverlay={false} />);

      expect(
        screen.getByTestId("timeline-clip-extension-label"),
      ).toHaveTextContent("No renderer · example.shapes/star");
      expect(screen.getByTestId("timeline-clip")).toHaveAttribute(
        "data-extension-provider",
        "renderer_unavailable",
      );
      expect(screen.getByTestId("timeline-clip")).toHaveAttribute(
        "data-extension-renderer",
        "unavailable",
      );
    } finally {
      registration.dispose();
    }
  });

  it("uses a trusted entity provider's timeline presentation", () => {
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
        label: "Procedural star",
        timelineColor: "#7c3aed",
        schemaVersion: 1,
        defaultPayload: { points: 5 },
        validate: () => undefined,
        createRenderable: () => ({
          object: new Container(),
          update: () => undefined,
        }),
      });
    const extensionClip: TimelineClipType = {
      id: "extension_renderable",
      trackId: "track_1",
      start: 0,
      timelineDuration: 100,
      type: "extension",
      name: "Registered star",
      transformations: [],
      offset: 0,
      sourceDuration: null,
      transformedDuration: 100,
      transformedOffset: 0,
      croppedSourceDuration: 100,
      extensionPayload: {
        extensionId: "example.shapes",
        typeId: "star",
        schemaVersion: 1,
        data: { points: 5 },
      },
    };

    try {
      render(<TimelineClipItem clip={extensionClip} isOverlay={false} />);

      expect(
        screen.getByTestId("timeline-clip-extension-label"),
      ).toHaveTextContent("Procedural star · example.shapes/star");
      expect(screen.getByTestId("timeline-clip")).toHaveAttribute(
        "data-extension-provider",
        "available",
      );
      expect(screen.getByTestId("timeline-clip")).toHaveAttribute(
        "data-extension-renderer",
        "available",
      );
      expect(screen.getByTestId("timeline-clip")).toHaveStyle({
        backgroundColor: "#7c3aed",
      });
    } finally {
      registration.dispose();
    }
  });

  it("applies resize deltas via CSS variables", () => {
    // Simulate a resize operation active on this clip
    useInteractionStore.setState({
      activeId: `resize_left_${mockClip.id}`,
      operation: "resize_left",
      currentDeltaX: 50,
      constraints: { minPx: -100, maxPx: 100 },
    });

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);
    const clipElement = screen.getByTestId("timeline-clip");

    // We can check if the style property was set on the element
    // Note: In JSDOM, style properties set via JS are reflected in the style object
    expect(clipElement.style.getPropertyValue("--drag-delta-x")).toBe("50px");
    expect(clipElement.style.getPropertyValue("--drag-delta-w")).toBe("-50px");
  });

  it("does not move a selected timeline clip with an external asset drag", () => {
    const draggedAssetClip: BaseClip = {
      id: "new_composite_placement",
      type: "video",
      name: "Composite",
      assetId: "baked-composite",
      compositeId: "composite-1",
      timelineDuration: 200,
      transformations: [],
      offset: 0,
      sourceDuration: 200,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 200,
    };
    useTimelineStore.setState({ selectedClipIds: [mockClip.id] });
    useInteractionStore.setState({
      activeId: "composite-asset-composite-1",
      activeClip: draggedAssetClip,
      operation: "move",
      currentDeltaX: 50,
      currentDeltaY: 20,
    });

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    expect(screen.getByTestId("timeline-clip").style.transform).toBe("");
  });

  it("continues to move selected followers during an internal timeline drag", () => {
    const leaderClip: TimelineClipType = {
      ...mockClip,
      id: "clip_leader",
    };
    useTimelineStore.setState({ selectedClipIds: [mockClip.id, leaderClip.id] });
    useInteractionStore.setState({
      activeId: leaderClip.id,
      activeClip: leaderClip,
      operation: "move",
      currentDeltaX: 50,
      currentDeltaY: 20,
    });

    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    expect(screen.getByTestId("timeline-clip").style.transform).toBe(
      "translate3d(50px, 20px, 0)",
    );
  });

  it("shows extract audio for clips with audio and opens the extraction dialog for the clicked clip", () => {
    render(<TimelineClipItem clip={mockClip} isOverlay={false} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Extract Audio" }));

    expect(extractionState.mockOpenSamAudioExtractDialog).toHaveBeenCalledWith(
      mockClip.id,
    );
  });

  it("does not show extract audio for audio clips", () => {
    render(
      <TimelineClipItem
        clip={{ ...mockClip, type: "audio" }}
        isOverlay={false}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));

    expect(
      screen.queryByRole("menuitem", { name: "Extract Audio" }),
    ).not.toBeInTheDocument();
  });

  it("does not show extract audio for clips without audio-capable media", () => {
    extractionState.mockUseAsset.mockReturnValue({
      id: "asset-1",
      hasAudio: false,
    } as Asset);

    render(
      <TimelineClipItem
        clip={{ ...mockClip, type: "image" }}
        isOverlay={false}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));

    expect(
      screen.queryByRole("menuitem", { name: "Extract Audio" }),
    ).not.toBeInTheDocument();
  });

  it("renders always-on overlay items while hiding selected-only items for unselected clips", () => {
    const overlays = [
      createOverlay("overlay-visibility", [
        createEndpointOverlayItem({
          id: "always-item",
          edge: "start",
          content: <div>Always</div>,
        }),
        createEndpointOverlayItem({
          id: "selected-item",
          edge: "end",
          visibility: "selected",
          content: <div>Selected</div>,
        }),
      ]),
    ];

    render(
      <TimelineClipItem
        clip={{ ...mockClip, timelineDuration: TICKS_PER_SECOND }}
        clipOverlays={overlays}
      />,
    );

    expect(screen.getByText("Always")).toBeInTheDocument();
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
  });

  it("pins endpoint overlay items to the visible clip edge and hides width-sensitive items when the clip is too narrow", () => {
    const endpointItem = createEndpointOverlayItem({
      id: "edge-item",
      edge: "start",
      insetPx: 12,
      minClipWidthPx: 60,
      content: <div>Edge</div>,
    });
    const overlays = [createOverlay("overlay-edge", [endpointItem])];

    viewStoreState.zoomScale = 0.5;
    const { rerender, queryByText } = render(
      <TimelineClipItem
        clip={{ ...mockClip, timelineDuration: TICKS_PER_SECOND }}
        clipOverlays={overlays}
      />,
    );

    expect(queryByText("Edge")).not.toBeInTheDocument();

    viewStoreState.zoomScale = 1;
    rerender(
      <TimelineClipItem
        clip={{ ...mockClip, timelineDuration: TICKS_PER_SECOND }}
        clipOverlays={overlays}
      />,
    );

    const edgeItem = screen.getByText("Edge").parentElement as HTMLElement;
    expect(edgeItem.style.marginLeft).toBe("12px");
    expect(edgeItem.style.left).toBe("");
  });

  it("positions source-time overlay items using transformed visual time", () => {
    const speedClip: TimelineClipType = {
      ...mockClip,
      start: 0,
      timelineDuration: 2 * TICKS_PER_SECOND,
      sourceDuration: 2 * TICKS_PER_SECOND,
      transformedDuration: TICKS_PER_SECOND,
      croppedSourceDuration: 2 * TICKS_PER_SECOND,
      transformations: [
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
    };

    const overlays = [
      createOverlay("overlay-time-mapping", [
        createSourceTimeOverlayItem({
          id: "source-item",
          sourceTimeTicks: TICKS_PER_SECOND,
          content: <div>Source</div>,
        }),
      ]),
    ];

    render(<TimelineClipItem clip={speedClip} clipOverlays={overlays} />);

    const expectedBaseLeft = `${
      (TICKS_PER_SECOND / 2 / TICKS_PER_SECOND) * PIXELS_PER_SECOND
    }px`;
    const sourceItem = screen.getByText("Source").parentElement as HTMLElement;

    expect(sourceItem.style.left).toContain(expectedBaseLeft);
  });

  it("positions source-time overlay items through the clip presentation map", () => {
    const clipWithKeyframeTransform: TimelineClipType = {
      ...mockClip,
      start: 0,
      timelineDuration: 2 * TICKS_PER_SECOND,
      sourceDuration: 2 * TICKS_PER_SECOND,
      transformedDuration: 2 * TICKS_PER_SECOND,
      croppedSourceDuration: 2 * TICKS_PER_SECOND,
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
        },
      ],
    };

    const presentation = {
      clipId: clipWithKeyframeTransform.id,
      trackId: clipWithKeyframeTransform.trackId,
      start: 0,
      end: TICKS_PER_SECOND,
      duration: TICKS_PER_SECOND,
      mapPresentationOffsetToClipOffset: (offset: number) => offset * 2,
      mapClipOffsetToPresentationOffset: (offset: number) => offset / 2,
    };

    const overlays = [
      createOverlay("overlay-presentation-mapping", [
        createSourceTimeOverlayItem({
          id: "source-item",
          sourceTimeTicks: TICKS_PER_SECOND,
          content: <div>Source</div>,
        }),
      ]),
    ];

    render(
      <TimelineClipItem
        clip={clipWithKeyframeTransform}
        presentation={presentation}
        clipOverlays={overlays}
      />,
    );

    const expectedBaseLeft = `${
      (TICKS_PER_SECOND / 2 / TICKS_PER_SECOND) * PIXELS_PER_SECOND
    }px`;
    const sourceItem = screen.getByText("Source").parentElement as HTMLElement;

    expect(sourceItem.style.left).toContain(expectedBaseLeft);
  });

  it("positions keyframe diamonds through the clip presentation map", () => {
    const clipWithKeyframes: TimelineClipType = {
      ...mockClip,
      id: "keyframe_clip",
      start: 0,
      timelineDuration: 2 * TICKS_PER_SECOND,
      sourceDuration: 2 * TICKS_PER_SECOND,
      transformedDuration: 2 * TICKS_PER_SECOND,
      croppedSourceDuration: 2 * TICKS_PER_SECOND,
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TICKS_PER_SECOND],
        },
      ],
    };

    const presentation = {
      clipId: clipWithKeyframes.id,
      trackId: clipWithKeyframes.trackId,
      start: 0,
      end: TICKS_PER_SECOND,
      duration: TICKS_PER_SECOND,
      mapPresentationOffsetToClipOffset: (offset: number) => offset * 2,
      mapClipOffsetToPresentationOffset: (offset: number) => offset / 2,
    };

    useTimelineStore.setState({ clips: [clipWithKeyframes] });
    useTransformationViewStore.setState({
      activeSection: {
        clipId: clipWithKeyframes.id,
        sectionId: getDefaultSectionId("layout"),
      },
    });

    render(
      <TimelineClipWithKeyframeOverlay
        clip={clipWithKeyframes}
        presentation={presentation}
      />,
    );

    const expectedBaseLeft = `${
      (TICKS_PER_SECOND / 2 / TICKS_PER_SECOND) * PIXELS_PER_SECOND
    }px`;
    const diamond = screen.getByTestId("timeline-keyframe-diamond");
    const overlayNode = diamond.parentElement as HTMLElement;

    expect(overlayNode.style.left).toContain(expectedBaseLeft);
  });

  it("emits pointer-drag callbacks with clip-local and time-mapped positions without firing click handlers", () => {
    const onClick = vi.fn();
    const onDragStart = vi.fn();
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();

    const overlays = [
      createOverlay("overlay-drag", [
        createEndpointOverlayItem({
          id: "drag-item",
          edge: "start",
          content: <div>Drag</div>,
          onClick,
          drag: {
            onDragStart,
            onDrag,
            onDragEnd,
          },
        }),
      ]),
    ];

    render(
      <TimelineClipItem
        clip={{ ...mockClip, start: 0, timelineDuration: 2 * TICKS_PER_SECOND }}
        clipOverlays={overlays}
      />,
    );

    const clipElement = screen.getByTestId("timeline-clip");
    Object.defineProperty(clipElement, "getBoundingClientRect", {
      value: () => ({
        left: 10,
        top: 0,
        width: 200,
        height: 40,
        right: 210,
        bottom: 40,
        x: 10,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    const dragItem = screen.getByText("Drag").parentElement as HTMLElement;

    fireEvent.pointerDown(dragItem, { pointerId: 1, clientX: 60 });
    fireEvent.pointerMove(dragItem, { pointerId: 1, clientX: 110 });
    fireEvent.pointerUp(dragItem, { pointerId: 1, clientX: 130 });
    fireEvent.click(dragItem);

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    expect(onDragStart.mock.calls[0][0]).toMatchObject({
      clipLocalX: 50,
      visualTimeTicks: 0.5 * TICKS_PER_SECOND,
      sourceTimeTicks: 0.5 * TICKS_PER_SECOND,
    });
    expect(onDrag.mock.calls[0][0]).toMatchObject({
      clipLocalX: 100,
      deltaClipX: 50,
    });
    expect(onDragEnd.mock.calls[0][0]).toMatchObject({
      clipLocalX: 120,
      deltaClipX: 70,
    });
  });

  it("maps pointer-drag positions from presentation space back to clip-local time", () => {
    const onDragStart = vi.fn();
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();

    const clip: TimelineClipType = {
      ...mockClip,
      start: 0,
      timelineDuration: 2 * TICKS_PER_SECOND,
      sourceDuration: 2 * TICKS_PER_SECOND,
      transformedDuration: 2 * TICKS_PER_SECOND,
      croppedSourceDuration: 2 * TICKS_PER_SECOND,
    };

    const presentation = {
      clipId: clip.id,
      trackId: clip.trackId,
      start: 0,
      end: TICKS_PER_SECOND,
      duration: TICKS_PER_SECOND,
      mapPresentationOffsetToClipOffset: (offset: number) => offset * 2,
      mapClipOffsetToPresentationOffset: (offset: number) => offset / 2,
    };

    const overlays = [
      createOverlay("overlay-drag-presentation", [
        createEndpointOverlayItem({
          id: "drag-item",
          edge: "start",
          content: <div>Drag</div>,
          drag: {
            onDragStart,
            onDrag,
            onDragEnd,
          },
        }),
      ]),
    ];

    render(
      <TimelineClipItem
        clip={clip}
        presentation={presentation}
        clipOverlays={overlays}
      />,
    );

    const clipElement = screen.getByTestId("timeline-clip");
    Object.defineProperty(clipElement, "getBoundingClientRect", {
      value: () => ({
        left: 10,
        top: 0,
        width: 100,
        height: 40,
        right: 110,
        bottom: 40,
        x: 10,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    const dragItem = screen.getByText("Drag").parentElement as HTMLElement;

    fireEvent.pointerDown(dragItem, { pointerId: 1, clientX: 60 });
    fireEvent.pointerMove(dragItem, { pointerId: 1, clientX: 85 });
    fireEvent.pointerUp(dragItem, { pointerId: 1, clientX: 85 });

    expect(onDragStart.mock.calls[0][0]).toMatchObject({
      clipLocalX: 50,
      presentationOffsetTicks: 0.5 * TICKS_PER_SECOND,
      visualTimeTicks: TICKS_PER_SECOND,
      sourceTimeTicks: TICKS_PER_SECOND,
    });
    expect(onDrag.mock.calls[0][0]).toMatchObject({
      clipLocalX: 75,
      presentationOffsetTicks: 0.75 * TICKS_PER_SECOND,
      visualTimeTicks: 1.5 * TICKS_PER_SECOND,
      deltaPresentationOffsetTicks: 0.25 * TICKS_PER_SECOND,
      deltaVisualTimeTicks: 0.5 * TICKS_PER_SECOND,
    });
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });
});
