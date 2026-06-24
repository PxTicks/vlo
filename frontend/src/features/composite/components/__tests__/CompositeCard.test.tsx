import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeAsset } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import { CompositeCard } from "../CompositeCard";

const mocks = vi.hoisted(() => ({
  asset: null as { thumbnail?: string; src?: string } | null,
  draggable: {
    attributes: { role: "button" },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    isDragging: false,
  },
  useDraggable: vi.fn(),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: mocks.useDraggable,
}));

vi.mock("../../../userAssets/api", () => ({
  useAsset: () => mocks.asset,
}));

function composite(): CompositeAsset {
  return {
    id: "composite-1",
    name: "Opening scene",
    bakedAssetId: "bake-1",
    createdAt: 1,
    updatedAt: 1,
    content: {
      clips: [],
      tracks: [],
      durationTicks: 2.5 * TICKS_PER_SECOND,
    },
  };
}

describe("CompositeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.asset = null;
    mocks.draggable.isDragging = false;
    mocks.useDraggable.mockReturnValue(mocks.draggable);
  });

  it("configures dragging and renders fallback content", () => {
    const handlers = {
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onPlaceOnTimeline: vi.fn(),
    };
    render(
      <CompositeCard
        composite={composite()}
        isSelected
        disableDrag
        {...handlers}
      />,
    );

    expect(mocks.useDraggable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "composite-asset-composite-1",
        disabled: true,
        data: expect.objectContaining({
          type: "asset",
          compositeAsset: expect.objectContaining({ id: "composite-1" }),
          clip: expect.objectContaining({ compositeId: "composite-1" }),
        }),
      }),
    );
    const card = screen.getByTestId("composite-card");
    expect(card).toHaveAttribute("data-selected", "true");
    expect(card).toHaveStyle({ cursor: "default", opacity: "1" });
    expect(screen.getByText("Opening scene")).toBeInTheDocument();
    expect(screen.getByText("2.50s")).toBeInTheDocument();
  });

  it("renders a thumbnail and dragging state", () => {
    mocks.asset = { thumbnail: "thumb.jpg", src: "source.mp4" };
    mocks.draggable.isDragging = true;
    render(
      <CompositeCard
        composite={composite()}
        isSelected={false}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPlaceOnTimeline={vi.fn()}
      />,
    );

    expect(document.querySelector("img")).toHaveAttribute("src", "thumb.jpg");
    expect(screen.getByTestId("composite-card")).toHaveStyle({
      opacity: "0.55",
      cursor: "grab",
    });
  });

  it("selects the card and isolates action button events", () => {
    const handlers = {
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onPlaceOnTimeline: vi.fn(),
    };
    render(
      <CompositeCard
        composite={composite()}
        isSelected={false}
        {...handlers}
      />,
    );

    fireEvent.click(screen.getByTestId("composite-card"));
    expect(handlers.onSelect).toHaveBeenCalledOnce();

    for (const [name, handler] of [
      ["Edit composite", handlers.onOpen],
      ["Place composite on timeline", handlers.onPlaceOnTimeline],
      ["Rename composite", handlers.onRename],
      ["Delete composite", handlers.onDelete],
    ] as const) {
      const button = screen.getByRole("button", { name });
      fireEvent.mouseDown(button);
      fireEvent.click(button);
      expect(handler).toHaveBeenCalledOnce();
    }
    expect(handlers.onSelect).toHaveBeenCalledOnce();
  });
});
