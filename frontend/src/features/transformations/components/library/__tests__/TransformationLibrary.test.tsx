import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TransformationCard,
  TransformationCardSurface,
} from "../TransformationCard";
import { TransformationLibraryPanel } from "../TransformationLibraryPanel";

const dnd = vi.hoisted(() => ({
  useDraggable: vi.fn(),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: dnd.useDraggable,
}));

vi.mock("../../../catalogue/TransformationRegistry", () => ({
  getAddableTransforms: vi.fn(() => [
    {
      type: "position",
      label: "Position",
      compatibleClips: "visual",
      createDefault: vi.fn(),
      controls: [],
    },
    {
      type: "filter",
      filterName: "blur",
      label: "Blur",
      compatibleClips: "visual",
      createDefault: vi.fn(),
      controls: [],
    },
    {
      type: "mask-grow",
      label: "Mask only",
      compatibleClips: "mask",
      createDefault: vi.fn(),
      controls: [],
    },
  ]),
}));

describe("transformation library", () => {
  beforeEach(() => {
    dnd.useDraggable.mockReturnValue({
      attributes: { role: "button" },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef: vi.fn(),
      isDragging: false,
    });
  });

  it("renders card surface states", () => {
    const { rerender } = render(<TransformationCardSurface label="Position" />);
    expect(screen.getByText("Position")).toBeInTheDocument();
    rerender(
      <TransformationCardSurface label="Rejected" isDragging isRejected />,
    );
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("registers filter and layout cards with drag metadata", () => {
    const { rerender } = render(
      <TransformationCard
        definition={{
          type: "filter",
          filterName: "blur",
          label: "Blur",
          compatibleClips: "visual",
          controls: [],
        } as never}
      />,
    );
    expect(dnd.useDraggable).toHaveBeenLastCalledWith({
      id: "transform_blur",
      data: {
        type: "transform",
        transformType: "blur",
        isFilter: true,
        label: "Blur",
      },
    });

    dnd.useDraggable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      isDragging: true,
    });
    rerender(
      <TransformationCard
        definition={{
          type: "position",
          label: "Position",
          compatibleClips: "visual",
          controls: [],
        } as never}
      />,
    );
    expect(dnd.useDraggable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "transform_position",
        data: expect.objectContaining({ isFilter: false }),
      }),
    );
  });

  it("lists addable non-mask transformations", () => {
    render(<TransformationLibraryPanel />);
    expect(screen.getByText("Effects")).toBeInTheDocument();
    expect(screen.getByText("Position")).toBeInTheDocument();
    expect(screen.getByText("Blur")).toBeInTheDocument();
    expect(screen.queryByText("Mask only")).not.toBeInTheDocument();
  });
});
