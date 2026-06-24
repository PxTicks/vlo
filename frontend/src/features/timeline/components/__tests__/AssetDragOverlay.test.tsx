import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  BaseClip,
  VideoBaseClip,
} from "../../../../types/TimelineTypes";
import { useInteractionStore } from "../../hooks/useInteractionStore";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import { AssetDragOverlay } from "../AssetDragOverlay";

const dnd = vi.hoisted(() => ({
  active: null as null | { data: { current: Record<string, unknown> } },
  dragOverlayProps: vi.fn(),
}));

vi.mock("@dnd-kit/core", () => ({
  useDndContext: vi.fn(() => ({ active: dnd.active })),
  DragOverlay: (props: {
    children: React.ReactNode;
    modifiers?: unknown[];
    style?: React.CSSProperties;
  }) => {
    dnd.dragOverlayProps(props);
    return <div data-testid="drag-overlay">{props.children}</div>;
  },
}));

vi.mock("../TimelineClip", () => ({
  TimelineClipItem: ({ clip, isOverlay }: { clip: BaseClip; isOverlay: boolean }) => (
    <div data-testid="clip-preview">
      {clip.name}:{String(isOverlay)}
    </div>
  ),
}));

const baseClip: VideoBaseClip = {
  id: "new-clip",
  name: "New clip",
  type: "video",
  assetId: "asset-1",
  timelineDuration: 100,
  offset: 0,
  transformedDuration: 100,
  transformedOffset: 0,
  croppedSourceDuration: 100,
  sourceDuration: 100,
  transformations: [],
};

const imageAsset: Asset = {
  id: "asset-1",
  hash: "hash",
  name: "Image",
  type: "image",
  src: "blob:image",
  createdAt: 1,
};

describe("AssetDragOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnd.active = null;
    useInteractionStore.setState({
      activeClip: null,
      operation: null,
      isOverTimeline: false,
    });
    useTimelineViewStore.setState({ zoomScale: 1.5 });
  });

  it("renders nothing without a new-asset move", () => {
    const { container, rerender } = render(<AssetDragOverlay />);
    expect(container).toBeEmptyDOMElement();

    useInteractionStore.setState({
      // The runtime distinguishes an already-placed clip by this property even
      // though the interaction store intentionally exposes the base-clip type.
      activeClip: {
        ...baseClip,
        trackId: "track-1",
      } as unknown as BaseClip,
      operation: "move",
    });
    rerender(<AssetDragOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an image thumbnail before entering the timeline", () => {
    dnd.active = { data: { current: { asset: imageAsset } } };
    useInteractionStore.setState({
      activeClip: baseClip,
      operation: "move",
      isOverTimeline: false,
    });
    const { container } = render(<AssetDragOverlay />);
    expect(container.querySelector("img")).toHaveAttribute("src", "blob:image");
    expect(screen.getByTestId("drag-overlay")).toBeInTheDocument();
  });

  it("renders a named placeholder for media without a thumbnail", () => {
    dnd.active = {
      data: {
        current: {
          asset: { ...imageAsset, type: "video", name: "Movie" },
        },
      },
    };
    useInteractionStore.setState({
      activeClip: baseClip,
      operation: "move",
      isOverTimeline: false,
    });
    render(<AssetDragOverlay />);
    expect(screen.getByText("Movie")).toBeInTheDocument();
  });

  it("renders the snapped clip preview over the timeline", () => {
    useInteractionStore.setState({
      activeClip: baseClip,
      operation: "move",
      isOverTimeline: true,
    });
    render(<AssetDragOverlay />);
    expect(screen.getByTestId("clip-preview")).toHaveTextContent("New clip:true");
    expect(dnd.dragOverlayProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modifiers: expect.any(Array),
        style: { "--timeline-zoom": 1.5 },
      }),
    );
  });
});
