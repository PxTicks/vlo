import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { AssetDropSlot } from "../AssetDropSlot";
import { getExternalFileDragHighlight } from "../assetDropSlotUtils";

const dnd = vi.hoisted(() => ({
  active: null as null | { data: { current: Record<string, unknown> } },
  isOver: false,
  isDragging: false,
  transform: null as null | {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  },
  setDroppableNodeRef: vi.fn(),
  setDraggableNodeRef: vi.fn(),
  listeners: { onPointerDown: vi.fn() },
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: vi.fn(() => ({
    setNodeRef: dnd.setDroppableNodeRef,
    isOver: dnd.isOver,
  })),
  useDraggable: vi.fn(() => ({
    listeners: dnd.listeners,
    attributes: {},
    setNodeRef: dnd.setDraggableNodeRef,
    transform: dnd.transform,
    isDragging: dnd.isDragging,
  })),
  useDndContext: vi.fn(() => ({ active: dnd.active })),
}));

function createDragData(type: string): Pick<
  DataTransfer,
  "types" | "items" | "files"
> {
  return {
    types: ["Files"],
    items: [{ kind: "file", type }],
    files: [],
  } as unknown as Pick<DataTransfer, "types" | "items" | "files">;
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    hash: "hash",
    name: "asset.png",
    type: "image",
    src: "blob:asset",
    createdAt: 1,
    ...overrides,
  };
}

describe("AssetDropSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnd.active = null;
    dnd.isOver = false;
    dnd.isDragging = false;
    dnd.transform = null;
  });

  it("renders an empty selectable slot and supports pointer and keyboard selection", () => {
    const onSelect = vi.fn();
    render(
      <AssetDropSlot
        id="source"
        accept={["image", "video"]}
        value={null}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("Image / Video")).toBeInTheDocument();
    expect(screen.getByText("Drop or click")).toBeInTheDocument();
    const slot = screen.getByRole("button");
    fireEvent.click(slot);
    fireEvent.keyDown(slot, { key: "Enter" });
    fireEvent.keyDown(slot, { key: " " });
    fireEvent.keyDown(slot, { key: "Escape" });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(dnd.setDroppableNodeRef).toHaveBeenCalled();
    expect(dnd.setDraggableNodeRef).toHaveBeenCalled();
  });

  it("renders image, audio, and missing-preview filled states", () => {
    const { rerender } = render(
      <AssetDropSlot
        id="source"
        accept={["image"]}
        value={makeAsset({ thumbnail: "blob:thumb" })}
      />,
    );
    expect(screen.getByRole("img", { name: "asset.png" })).toHaveAttribute(
      "src",
      "blob:thumb",
    );

    rerender(
      <AssetDropSlot
        id="source"
        accept={["audio"]}
        value={makeAsset({ type: "audio", name: "sound.wav" })}
      />,
    );
    expect(screen.queryByText("No Preview")).not.toBeInTheDocument();
    expect(screen.getByTitle("sound.wav")).toBeInTheDocument();

    rerender(
      <AssetDropSlot
        id="source"
        accept={["video"]}
        value={makeAsset({ type: "video", name: "movie.mp4" })}
      />,
    );
    expect(screen.getByText("No Preview")).toBeInTheDocument();
  });

  it("invokes edit and clear without selecting the slot", () => {
    const onEdit = vi.fn();
    const onClear = vi.fn();
    const onSelect = vi.fn();
    render(
      <AssetDropSlot
        id="source"
        accept={["image"]}
        value={makeAsset()}
        onEdit={onEdit}
        onClear={onClear}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const clear = document.querySelector(".drop-slot-clear");
    expect(clear).not.toBeNull();
    fireEvent.click(clear!);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accepts compatible external files and ignores incompatible drops", () => {
    const onExternalDrop = vi.fn();
    const image = new File(["image"], "image.png", { type: "image/png" });
    const video = new File(["video"], "video.mp4", { type: "video/mp4" });
    const { container } = render(
      <AssetDropSlot
        id="source"
        accept={["image"]}
        value={null}
        onExternalDrop={onExternalDrop}
      />,
    );
    const slot = container.querySelector("[data-drop-slot-id='source']")!;
    const imageTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }],
      files: [image],
      dropEffect: "none",
    };
    fireEvent.dragEnter(slot, { dataTransfer: imageTransfer });
    fireEvent.dragOver(slot, { dataTransfer: imageTransfer });
    expect(imageTransfer.dropEffect).toBe("copy");
    fireEvent.dragLeave(slot, { dataTransfer: imageTransfer });
    fireEvent.drop(slot, { dataTransfer: imageTransfer });
    expect(onExternalDrop).toHaveBeenCalledWith(image);

    const videoTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "video/mp4" }],
      files: [video],
      dropEffect: "copy",
    };
    fireEvent.dragEnter(slot, { dataTransfer: videoTransfer });
    fireEvent.dragOver(slot, { dataTransfer: videoTransfer });
    expect(videoTransfer.dropEffect).toBe("none");
    fireEvent.drop(slot, { dataTransfer: videoTransfer });
    expect(onExternalDrop).toHaveBeenCalledTimes(1);
  });

  it("ignores non-file drags and renders internal compatibility states", () => {
    dnd.isOver = true;
    dnd.active = {
      data: {
        current: {
          type: "asset",
          asset: makeAsset({ type: "video" }),
        },
      },
    };
    const onExternalDrop = vi.fn();
    const { container, rerender } = render(
      <AssetDropSlot
        id="source"
        accept={["image"]}
        value={null}
        onExternalDrop={onExternalDrop}
      />,
    );
    const slot = container.querySelector("[data-drop-slot-id='source']")!;
    fireEvent.dragEnter(slot, {
      dataTransfer: { types: ["text/plain"], items: [], files: [] },
    });
    expect(onExternalDrop).not.toHaveBeenCalled();

    dnd.active = {
      data: {
        current: {
          type: "media-input",
          inputId: "other",
        },
      },
    };
    rerender(
      <AssetDropSlot
        id="source"
        accept={["image"]}
        value={makeAsset()}
        reorderData={{ type: "media-input", inputId: "source" }}
        onReorderDrop={vi.fn()}
      />,
    );
    expect(dnd.listeners.onPointerDown).toBeDefined();
  });
});

describe("getExternalFileDragHighlight", () => {
  it("treats matching typed file items as compatible", () => {
    expect(
      getExternalFileDragHighlight(createDragData("image/png"), ["image"]),
    ).toBe("compatible");
  });

  it("treats known mismatched file items as incompatible", () => {
    expect(
      getExternalFileDragHighlight(createDragData("video/mp4"), ["image"]),
    ).toBe("incompatible");
  });

  it("falls back to a neutral highlight when file items expose no type yet", () => {
    expect(getExternalFileDragHighlight(createDragData(""), ["image"])).toBe(
      "external",
    );
  });
});
