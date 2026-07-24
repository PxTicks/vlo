import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  getMenuTreeChildren,
  type MenuTreeItem,
  type MenuTreeLayout,
} from "../../../core/shell/menuTree";

export interface MenuTreeDragData {
  readonly item: MenuTreeItem;
  readonly parentId: string | null;
}

export interface MenuTreeDropContainerData {
  readonly parentId: string | null;
  /**
   * Set on the droppable that covers a folder's own tile. Such a container
   * overlaps the folder's sortable rect exactly, so it only ever wins a
   * collision through the pointer-first pass in `menuTreeCollisionDetection`.
   */
  readonly isFolderTile?: boolean;
}

export interface MenuTreeDropTarget {
  readonly item: MenuTreeItem;
  readonly parentId: string | null;
  readonly index: number;
}

export function menuTreeItemDndId(item: MenuTreeItem): string {
  return `menu-tree:${item.kind}:${item.id}`;
}

export function menuTreeContainerDndId(parentId: string | null): string {
  return `menu-tree-container:${parentId ?? "__root__"}`;
}

/**
 * A folder tile is both a sortable item (so folders can be reordered) and a
 * drop container (so leaves can be filed into it) over the same rectangle.
 * `closestCenter` alone always resolves that overlap in favour of the sortable
 * item, which is why dragging a workflow onto a folder used to reorder it
 * beside the folder instead of moving it inside. Leaves therefore get a
 * pointer-first pass that prefers the tile container; nodes keep the plain
 * `closestCenter` behaviour so folders still reorder against each other.
 */
export const menuTreeCollisionDetection: CollisionDetection = (args) => {
  const active = args.active.data.current as MenuTreeDragData | undefined;
  if (active?.item.kind === "leaf") {
    const tileHit = pointerWithin(args).find((collision) => {
      const data = collision.data?.droppableContainer?.data?.current as
        | MenuTreeDropContainerData
        | undefined;
      return data?.isFolderTile === true;
    });
    if (tileHit) return [tileHit];
  }
  return closestCenter(args);
};

/**
 * Resolves a dnd-kit drop into a `moveMenuTreeItem` call. Dropping on a
 * container appends to it; dropping on an item takes that item's slot, which
 * matches `arrayMove` semantics in both directions because `moveMenuTreeItem`
 * splices into a sibling list that excludes the dragged item.
 */
export function resolveDropTarget(
  layout: MenuTreeLayout,
  event: DragEndEvent,
): MenuTreeDropTarget | null {
  if (!event.over) return null;
  const activeData = event.active.data.current as MenuTreeDragData | undefined;
  if (!activeData) return null;

  const overData = event.over.data.current as
    | MenuTreeDragData
    | { readonly parentId: string | null }
    | undefined;

  if (String(event.over.id).startsWith("menu-tree-container:")) {
    const parentId = overData?.parentId ?? null;
    return {
      item: activeData.item,
      parentId,
      index: getMenuTreeChildren(layout, parentId).length,
    };
  }

  const overItem = (overData as MenuTreeDragData | undefined)?.item;
  if (!overItem) return null;
  const parentId = (overData as MenuTreeDragData).parentId;
  const index = getMenuTreeChildren(layout, parentId).findIndex(
    (item) => item.kind === overItem.kind && item.id === overItem.id,
  );
  return { item: activeData.item, parentId, index: Math.max(0, index) };
}
