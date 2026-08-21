import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  closestCenter,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { NestedMenuTree, type NestedMenuLeaf } from "../NestedMenuTree";
import {
  menuTreeCollisionDetection,
  resolveDropTarget,
  type MenuTreeDragData,
  type MenuTreeDropContainerData,
} from "../menuTreeDrop";
import { resolveMenuNodeIcon } from "../menuTreeIcons";
import {
  moveMenuTreeItem,
  type MenuTreeItem,
  type MenuTreeLayout,
} from "../../../../core/shell/menuTree";

const LAYOUT: MenuTreeLayout = {
  nodes: [
    {
      id: "image",
      kind: "category",
      label: "Image",
      parentId: null,
      order: 0,
    },
    {
      id: "image.generate",
      kind: "folder",
      label: "Generate",
      parentId: "image",
      order: 0,
    },
    {
      id: "empty",
      kind: "folder",
      label: "Empty",
      parentId: null,
      order: 1,
    },
  ],
  leafPlacements: [
    { leafId: "flux", parentId: "image.generate", order: 0 },
    { leafId: "other", parentId: null, order: 2 },
  ],
};

const LEAVES: NestedMenuLeaf[] = [
  { id: "flux", label: "Flux" },
  { id: "other", label: "Other workflow" },
];

function renderTree(
  overrides: Partial<React.ComponentProps<typeof NestedMenuTree<NestedMenuLeaf>>> = {},
) {
  const onLeafActivate = vi.fn();
  const onSave = vi.fn(async (_layout: MenuTreeLayout) => true);
  const onReset = vi.fn(async () => true);
  render(
    <NestedMenuTree
      ariaLabel="Generation workflows"
      layout={LAYOUT}
      defaultLayout={LAYOUT}
      leaves={LEAVES}
      selectedLeafId={null}
      onLeafActivate={onLeafActivate}
      onSave={onSave}
      onReset={onReset}
      {...overrides}
    />,
  );
  return { onLeafActivate, onSave, onReset };
}

describe("NestedMenuTree", () => {
  it("flattens categories, navigates folders, and keeps selection in place", () => {
    const { onLeafActivate } = renderTree();

    expect(screen.getByRole("heading", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Empty/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Flux" }));
    expect(onLeafActivate).toHaveBeenCalledWith(LEAVES[0]);
    expect(screen.getByRole("button", { name: "Flux" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to previous menu" }),
    ).toBeInTheDocument();
  });

  it("reports navigation to the owner when the current folder is controlled", () => {
    const onCurrentParentIdChange = vi.fn();
    renderTree({ currentParentId: null, onCurrentParentIdChange });

    fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
    expect(onCurrentParentIdChange).toHaveBeenCalledWith("image.generate");
    // The owner holds the state, so the tree itself must not have navigated.
    expect(
      screen.queryByRole("button", { name: "Back to previous menu" }),
    ).not.toBeInTheDocument();
  });

  it("opens the controlled folder and walks back one level from it", () => {
    const onCurrentParentIdChange = vi.fn();
    renderTree({
      currentParentId: "image.generate",
      onCurrentParentIdChange,
    });

    expect(screen.getByRole("button", { name: "Flux" })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to previous menu" }),
    );
    expect(onCurrentParentIdChange).toHaveBeenCalledWith(null);
  });

  it("shows empty nodes in edit mode and cancels a draft", async () => {
    const { onSave } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Empty" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My folder" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "My folder" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /My folder/ })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renames nodes, prevents non-empty deletion, and saves once on Done", async () => {
    const { onSave } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Delete Image" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rename Image" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Pictures" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Pictures" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].nodes).toContainEqual(
      expect.objectContaining({ id: "image", label: "Pictures" }),
    );
  });

  it("stages a confirmed reset and applies it through Done", async () => {
    const { onSave, onReset } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Reset menu to defaults?" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("opens a folder from its tile while editing so its contents stay reachable", () => {
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.getByRole("button", { name: "Flux" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to previous menu" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("retains the draft and reports save failures", async () => {
    const onSave = vi.fn(async () => false);
    renderTree({
      onSave,
      persistenceError: "Could not save menu",
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.getByText("Could not save menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});

function dragEvent(
  item: MenuTreeItem,
  parentId: string | null,
  over: { id: string; data: Record<string, unknown> } | null,
): DragEndEvent {
  return {
    active: { id: "active", data: { current: { item, parentId } } },
    over: over
      ? { id: over.id, data: { current: over.data } }
      : null,
  } as unknown as DragEndEvent;
}

function rect(left: number, top: number) {
  return {
    top,
    left,
    width: 100,
    height: 100,
    right: left + 100,
    bottom: top + 100,
  };
}

/**
 * A folder tile registers two droppables over the same rectangle — its
 * sortable item and its drop container — which is the overlap the collision
 * detection has to resolve.
 */
const DROPPABLES: readonly {
  id: string;
  data: MenuTreeDragData | MenuTreeDropContainerData;
  rect: ReturnType<typeof rect>;
}[] = [
  {
    id: "menu-tree:node:image.generate",
    data: { item: { kind: "node", id: "image.generate" }, parentId: "image" },
    rect: rect(0, 0),
  },
  {
    id: "menu-tree-container:image.generate",
    data: { parentId: "image.generate", isFolderTile: true },
    rect: rect(0, 0),
  },
  {
    id: "menu-tree:leaf:other",
    data: { item: { kind: "leaf", id: "other" }, parentId: null },
    rect: rect(0, 200),
  },
];

function collisionArgs(
  active: MenuTreeDragData,
  pointerCoordinates: { x: number; y: number } | null,
): Parameters<CollisionDetection>[0] {
  return {
    active: { id: "active", data: { current: active } },
    collisionRect: rect(0, 0),
    droppableRects: new Map(
      DROPPABLES.map((droppable) => [droppable.id, droppable.rect]),
    ),
    droppableContainers: DROPPABLES.map((droppable) => ({
      id: droppable.id,
      data: { current: droppable.data },
      rect: { current: droppable.rect },
    })),
    pointerCoordinates,
  } as unknown as Parameters<CollisionDetection>[0];
}

describe("resolveDropTarget", () => {
  it("appends to the container when dropped on empty container space", () => {
    const target = resolveDropTarget(
      LAYOUT,
      dragEvent({ kind: "leaf", id: "other" }, null, {
        id: "menu-tree-container:image.generate",
        data: { parentId: "image.generate" },
      }),
    );

    expect(target).toEqual({
      item: { kind: "leaf", id: "other" },
      parentId: "image.generate",
      index: 1,
    });
  });

  it("takes the slot of the item it is dropped on", () => {
    const target = resolveDropTarget(
      LAYOUT,
      dragEvent({ kind: "leaf", id: "other" }, null, {
        id: "menu-tree:node:image.generate",
        data: {
          item: { kind: "node", id: "image.generate" },
          parentId: "image",
        },
      }),
    );

    expect(target).toEqual({
      item: { kind: "leaf", id: "other" },
      parentId: "image",
      index: 0,
    });
  });

  it("reorders within a parent identically in both directions", () => {
    const flat: MenuTreeLayout = {
      nodes: [],
      leafPlacements: [
        { leafId: "a", parentId: null, order: 0 },
        { leafId: "b", parentId: null, order: 1 },
        { leafId: "c", parentId: null, order: 2 },
      ],
    };
    const dropOn = (dragged: string, overLeaf: string) => {
      const target = resolveDropTarget(
        flat,
        dragEvent({ kind: "leaf", id: dragged }, null, {
          id: `menu-tree:leaf:${overLeaf}`,
          data: { item: { kind: "leaf", id: overLeaf }, parentId: null },
        }),
      )!;
      return moveMenuTreeItem(
        flat,
        target.item,
        target.parentId,
        target.index,
      )
        .leafPlacements.slice()
        .sort((x, y) => x.order - y.order)
        .map((placement) => placement.leafId);
    };

    expect(dropOn("a", "c")).toEqual(["b", "c", "a"]);
    expect(dropOn("c", "a")).toEqual(["c", "a", "b"]);
  });

  it("ignores drops outside a droppable or without drag data", () => {
    expect(
      resolveDropTarget(LAYOUT, dragEvent({ kind: "leaf", id: "other" }, null, null)),
    ).toBeNull();

    const withoutOverData = {
      active: { id: "active", data: { current: { item: { kind: "leaf", id: "other" }, parentId: null } } },
      over: { id: "menu-tree:leaf:flux", data: { current: undefined } },
    } as unknown as DragEndEvent;
    expect(resolveDropTarget(LAYOUT, withoutOverData)).toBeNull();
  });

  it("files a leaf into the folder tile the pointer is over", () => {
    const collisions = menuTreeCollisionDetection(
      collisionArgs({ item: { kind: "leaf", id: "other" }, parentId: null }, {
        x: 50,
        y: 50,
      }),
    );

    expect(collisions[0]?.id).toBe("menu-tree-container:image.generate");
    expect(
      resolveDropTarget(
        LAYOUT,
        dragEvent({ kind: "leaf", id: "other" }, null, {
          id: String(collisions[0]!.id),
          data: { parentId: "image.generate", isFolderTile: true },
        }),
      ),
    ).toEqual({
      item: { kind: "leaf", id: "other" },
      parentId: "image.generate",
      index: 1,
    });
  });

  it("leaves folder-against-folder drags to the default sorting", () => {
    const args = collisionArgs(
      { item: { kind: "node", id: "empty" }, parentId: null },
      { x: 50, y: 50 },
    );

    expect(menuTreeCollisionDetection(args)).toEqual(closestCenter(args));
  });

  it("falls back to the default sorting without pointer coordinates", () => {
    const args = collisionArgs(
      { item: { kind: "leaf", id: "other" }, parentId: null },
      null,
    );

    expect(menuTreeCollisionDetection(args)).toEqual(closestCenter(args));
  });

  it("resolves drops that moveMenuTreeItem rejects, leaving the caller to report them", () => {
    const target = resolveDropTarget(
      LAYOUT,
      dragEvent({ kind: "node", id: "image" }, null, {
        id: "menu-tree-container:image.generate",
        data: { parentId: "image.generate" },
      }),
    )!;

    expect(() =>
      moveMenuTreeItem(LAYOUT, target.item, target.parentId, target.index),
    ).toThrow(/cannot be moved into itself/);
  });
});

describe("resolveMenuNodeIcon", () => {
  const node = (id: string, label: string) =>
    ({ id, label, kind: "folder", parentId: null, order: 0 }) as const;

  it("prefers the action a folder performs over the media it acts on", () => {
    const generate = resolveMenuNodeIcon(node("video.generate", "Generate"));
    const enhance = resolveMenuNodeIcon(node("video.enhance", "Enhance"));
    const video = resolveMenuNodeIcon(node("video", "Video"));

    expect(generate).not.toBe(video);
    expect(enhance).not.toBe(generate);
    expect(resolveMenuNodeIcon(node("image.generate", "Generate"))).toBe(
      generate,
    );
  });

  it("falls back to a folder icon for names it cannot classify", () => {
    expect(resolveMenuNodeIcon(node("user.zzz.1234", "Zzz"))).toBe(
      resolveMenuNodeIcon(node("user.qqq.5678", "Qqq")),
    );
  });
});
