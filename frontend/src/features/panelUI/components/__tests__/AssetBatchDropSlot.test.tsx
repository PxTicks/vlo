import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssetBatchDropSlot } from "../AssetBatchDropSlot";
import type { AssetBatchSlotItem } from "../assetBatchDropSlotTypes";

const dnd = vi.hoisted(() => ({
  active: null as null | { data: { current: Record<string, unknown> } },
  isOver: false,
  isDragging: false,
  droppables: [] as Array<{ id: string; data: Record<string, unknown> }>,
  setDroppableNodeRef: vi.fn(),
  setDraggableNodeRef: vi.fn(),
  listeners: { onPointerDown: vi.fn() },
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: vi.fn((args: { id: string; data: Record<string, unknown> }) => {
    dnd.droppables.push(args);
    return { setNodeRef: dnd.setDroppableNodeRef, isOver: dnd.isOver };
  }),
  useDraggable: vi.fn(() => ({
    listeners: dnd.listeners,
    attributes: {},
    setNodeRef: dnd.setDraggableNodeRef,
    transform: null,
    isDragging: dnd.isDragging,
  })),
  useDndContext: vi.fn(() => ({ active: dnd.active })),
}));

function makeItems(count: number): AssetBatchSlotItem[] {
  return Array.from({ length: count }, (_, index) => ({
    slotId: `142:files::repeat::${index}`,
    value: {
      type: "video" as const,
      name: `clip-${index}.mp4`,
      thumbnail: `blob:thumb-${index}`,
    },
    editable: true,
  }));
}

function renderStrip(
  overrides: Partial<React.ComponentProps<typeof AssetBatchDropSlot>> = {},
) {
  const props = {
    id: "142:files",
    accept: ["video" as const],
    items: makeItems(2),
    max: 3,
    itemLabel: (index: number) => `Video ${index + 1}`,
    ...overrides,
  };
  return { ...render(<AssetBatchDropSlot {...props} />), props };
}

describe("AssetBatchDropSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnd.active = null;
    dnd.isOver = false;
    dnd.isDragging = false;
    dnd.droppables = [];
  });

  it("telescopes to the items it holds and offers one add tile below the ceiling", () => {
    const { container, rerender, props } = renderStrip();

    expect(container.querySelectorAll("[data-drop-slot-id]")).toHaveLength(3);
    expect(screen.getByText("2/3 · drag to reorder")).toBeInTheDocument();
    expect(
      container.querySelector("[data-drop-slot-id='142:files-add']"),
    ).not.toBeNull();

    rerender(<AssetBatchDropSlot {...props} items={makeItems(3)} />);
    expect(container.querySelectorAll("[data-drop-slot-id]")).toHaveLength(3);
    expect(
      container.querySelector("[data-drop-slot-id='142:files-add']"),
    ).toBeNull();
  });

  it("routes drops and selection to the position that received them", () => {
    const onDrop = vi.fn();
    const onSelect = vi.fn();
    renderStrip({ onDrop, onSelect });

    // The add tile targets the first free position; existing tiles replace.
    const addDroppable = dnd.droppables.find(
      (droppable) => droppable.id === "asset-slot-142:files-add",
    );
    const firstDroppable = dnd.droppables.find(
      (droppable) => droppable.id === "asset-slot-142:files::repeat::0",
    );
    const asset = { id: "a" } as never;
    (addDroppable!.data.onDrop as (asset: never) => void)(asset);
    (firstDroppable!.data.onDrop as (asset: never) => void)(asset);
    expect(onDrop).toHaveBeenNthCalledWith(1, 2, asset);
    expect(onDrop).toHaveBeenNthCalledWith(2, 0, asset);

    fireEvent.click(screen.getByLabelText("Video 1 — clip-0.mp4"));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("reorders to the index the item was dropped on", () => {
    const onReorder = vi.fn();
    renderStrip({ onReorder });

    const secondDroppable = dnd.droppables.find(
      (droppable) => droppable.id === "asset-slot-142:files::repeat::1",
    );
    (
      secondDroppable!.data.onReorderDrop as (data: {
        type: "media-input";
        inputId: string;
      }) => void
    )({ type: "media-input", inputId: "142:files::repeat::0" });

    expect(onReorder).toHaveBeenCalledWith("142:files::repeat::0", 1);
  });

  it("toggles a per-item option without clearing or selecting the item", () => {
    const onToggleOption = vi.fn();
    const onSelect = vi.fn();
    const onClear = vi.fn();
    const items = makeItems(1);
    items[0] = {
      ...items[0],
      options: [
        {
          id: "audio",
          icon: "audio",
          active: false,
          label: "Include this video's audio as a reference",
        },
      ],
    };
    renderStrip({ items, onToggleOption, onSelect, onClear });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Include this video's audio as a reference",
      }),
    );
    expect(onToggleOption).toHaveBeenCalledWith(
      "142:files::repeat::0",
      "audio",
      true,
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("clears and edits the item the affordance belongs to", () => {
    const onClear = vi.fn();
    const onEdit = vi.fn();
    renderStrip({ onClear, onEdit });

    fireEvent.click(screen.getByRole("button", { name: "Remove Video 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Video 2" }));
    expect(onClear).toHaveBeenCalledWith("142:files::repeat::1");
    expect(onEdit).toHaveBeenCalledWith("142:files::repeat::1");
  });

  it("hands an external file to the position it was dropped on", () => {
    const onExternalDrop = vi.fn();
    const { container } = renderStrip({ onExternalDrop });
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    const transfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "video/mp4" }],
      files: [file],
      dropEffect: "none",
    };
    const addTile = container.querySelector(
      "[data-drop-slot-id='142:files-add']",
    )!;

    fireEvent.dragEnter(addTile, { dataTransfer: transfer });
    fireEvent.dragOver(addTile, { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe("copy");
    fireEvent.drop(addTile, { dataTransfer: transfer });
    expect(onExternalDrop).toHaveBeenCalledWith(2, file);
  });
});
