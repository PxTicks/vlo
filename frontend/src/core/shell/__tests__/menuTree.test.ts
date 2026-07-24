import { describe, expect, it } from "vitest";
import {
  MENU_TREE_VERSION,
  addMenuTreeNode,
  assertMenuTreeDefinition,
  createMenuTreeCustomization,
  deleteMenuTreeNode,
  moveMenuTreeItem,
  renameMenuTreeNode,
  resolveMenuTreeLayout,
  type MenuTreeDefinition,
} from "../menuTree";

const DEFINITION: MenuTreeDefinition = {
  version: MENU_TREE_VERSION,
  id: "generation.workflows",
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
      id: "video",
      kind: "category",
      label: "Video",
      parentId: null,
      order: 1,
    },
  ],
  leafPlacements: [
    { leafId: "flux.json", parentId: "image.generate", order: 0 },
  ],
};

describe("menuTree", () => {
  it("rejects duplicate leaves, missing parents, category nesting, and cycles", () => {
    expect(() =>
      assertMenuTreeDefinition({
        ...DEFINITION,
        leafPlacements: [...DEFINITION.leafPlacements, DEFINITION.leafPlacements[0]],
      }),
    ).toThrow(/Duplicate menu tree leaf/);

    expect(() =>
      assertMenuTreeDefinition({
        ...DEFINITION,
        nodes: [
          ...DEFINITION.nodes,
          {
            id: "missing-child",
            kind: "folder",
            label: "Missing",
            parentId: "not-there",
            order: 0,
          },
        ],
      }),
    ).toThrow(/missing parent/);

    expect(() =>
      assertMenuTreeDefinition({
        ...DEFINITION,
        nodes: [
          ...DEFINITION.nodes,
          {
            id: "image.nested",
            kind: "category",
            label: "Nested",
            parentId: "image",
            order: 1,
          },
        ],
      }),
    ).toThrow(/cannot be nested/);

    expect(() =>
      assertMenuTreeDefinition({
        ...DEFINITION,
        nodes: [
          {
            id: "a",
            kind: "folder",
            label: "A",
            parentId: "b",
            order: 0,
          },
          {
            id: "b",
            kind: "folder",
            label: "B",
            parentId: "a",
            order: 0,
          },
        ],
        leafPlacements: [],
      }),
    ).toThrow(/cycle/);
  });

  it("layers overrides over defaults and sends new leaves to the root", () => {
    const resolved = resolveMenuTreeLayout(
      DEFINITION,
      {
        version: MENU_TREE_VERSION,
        customNodes: [
          {
            id: "favourites",
            kind: "folder",
            label: "Favourites",
            parentId: null,
            order: 0,
          },
        ],
        nodeOverrides: [
          { id: "video", label: "Motion", order: 3 },
          { id: "image.generate", deleted: true },
        ],
        leafPlacements: [
          { leafId: "flux.json", parentId: "favourites", order: 0 },
        ],
      },
      ["flux.json", "new.json"],
    );

    expect(resolved.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "video", label: "Motion", order: 3 }),
        expect.objectContaining({ id: "favourites" }),
      ]),
    );
    expect(resolved.nodes.some((node) => node.id === "image.generate")).toBe(
      false,
    );
    expect(resolved.leafPlacements).toEqual(
      expect.arrayContaining([
        { leafId: "flux.json", parentId: "favourites", order: 0 },
        expect.objectContaining({ leafId: "new.json", parentId: null }),
      ]),
    );
  });

  it("serializes only differences and admits later default leaves", () => {
    let layout = resolveMenuTreeLayout(DEFINITION, null, [
      "flux.json",
      "custom.json",
    ]);
    layout = addMenuTreeNode(layout, {
      id: "custom",
      kind: "folder",
      label: "Custom",
      parentId: null,
    });
    layout = moveMenuTreeItem(
      layout,
      { kind: "leaf", id: "custom.json" },
      "custom",
      0,
    );
    layout = renameMenuTreeNode(layout, "video", "Control");

    const customization = createMenuTreeCustomization(DEFINITION, layout);
    expect(customization.customNodes).toEqual([
      expect.objectContaining({ id: "custom" }),
    ]);
    expect(customization.nodeOverrides).toEqual([
      expect.objectContaining({ id: "video", label: "Control" }),
    ]);
    expect(customization.leafPlacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leafId: "custom.json",
          parentId: "custom",
        }),
      ]),
    );

    const nextDefinition: MenuTreeDefinition = {
      ...DEFINITION,
      leafPlacements: [
        ...DEFINITION.leafPlacements,
        { leafId: "future.json", parentId: "video", order: 0 },
      ],
    };
    expect(
      resolveMenuTreeLayout(nextDefinition, customization, [
        "flux.json",
        "custom.json",
        "future.json",
      ]).leafPlacements,
    ).toContainEqual({
      leafId: "future.json",
      parentId: "video",
      order: 0,
    });
  });

  it("round-trips a custom folder nested beneath a default category", () => {
    let layout = resolveMenuTreeLayout(DEFINITION, null, ["flux.json"]);
    layout = addMenuTreeNode(layout, {
      id: "image.favourites",
      kind: "folder",
      label: "Favourites",
      parentId: "image",
    });
    const customization = createMenuTreeCustomization(DEFINITION, layout);

    expect(customization.customNodes).toEqual([
      expect.objectContaining({
        id: "image.favourites",
        parentId: "image",
      }),
    ]);
    expect(
      resolveMenuTreeLayout(DEFINITION, customization, ["flux.json"]).nodes,
    ).toContainEqual(
      expect.objectContaining({
        id: "image.favourites",
        parentId: "image",
      }),
    );
  });

  it("moves nodes immutably and rejects invalid moves or non-empty deletion", () => {
    const layout = resolveMenuTreeLayout(DEFINITION, null, ["flux.json"]);
    const moved = moveMenuTreeItem(
      layout,
      { kind: "node", id: "video" },
      "image.generate",
      0,
    );
    expect(
      moved.nodes.find((node) => node.id === "video")?.parentId,
    ).toBe("image.generate");
    expect(layout.nodes.find((node) => node.id === "video")?.parentId).toBe(
      null,
    );

    expect(() =>
      moveMenuTreeItem(
        layout,
        { kind: "node", id: "image" },
        "image.generate",
        0,
      ),
    ).toThrow(/cannot be moved into itself/);
    expect(() => deleteMenuTreeNode(layout, "image")).toThrow(/must be empty/);

    const withEmpty = addMenuTreeNode(layout, {
      id: "empty",
      kind: "folder",
      label: "Empty",
      parentId: null,
    });
    expect(deleteMenuTreeNode(withEmpty, "empty").nodes).not.toContainEqual(
      expect.objectContaining({ id: "empty" }),
    );
  });

  it("repairs a cycle introduced by overrides instead of rejecting the layout", () => {
    // A shipped definition that reparents a node the user already moved can
    // close a cycle between two otherwise-valid overrides.
    const layout = resolveMenuTreeLayout(
      DEFINITION,
      {
        version: MENU_TREE_VERSION,
        customNodes: [],
        nodeOverrides: [
          { id: "image", parentId: "image.generate" },
          { id: "image.generate", parentId: "image" },
        ],
        leafPlacements: [],
      },
      ["flux.json"],
    );

    // The edge that closes the cycle is dropped; the other one survives, and
    // no node is discarded.
    const parents = new Map(
      layout.nodes.map((node) => [node.id, node.parentId]),
    );
    expect(parents.get("image")).toBe("image.generate");
    expect(parents.get("image.generate")).toBe(null);
    expect(layout.nodes).toHaveLength(DEFINITION.nodes.length);
  });

  it("reparents to root when an override nests a category under a category", () => {
    const layout = resolveMenuTreeLayout(
      DEFINITION,
      {
        version: MENU_TREE_VERSION,
        customNodes: [],
        nodeOverrides: [{ id: "video", parentId: "image" }],
        leafPlacements: [],
      },
      ["flux.json"],
    );

    expect(layout.nodes.find((node) => node.id === "video")?.parentId).toBe(
      null,
    );
  });

  it("reparents nodes to root when their persisted parent no longer exists", () => {
    const layout = resolveMenuTreeLayout(
      DEFINITION,
      {
        version: MENU_TREE_VERSION,
        customNodes: [
          {
            id: "orphan",
            kind: "folder",
            label: "Orphan",
            parentId: "removed.parent",
            order: 0,
          },
          {
            id: "orphan.child",
            kind: "folder",
            label: "Child",
            parentId: "orphan",
            order: 0,
          },
        ],
        nodeOverrides: [],
        leafPlacements: [],
      },
      ["flux.json"],
    );

    expect(layout.nodes.find((node) => node.id === "orphan")?.parentId).toBe(
      null,
    );
    expect(
      layout.nodes.find((node) => node.id === "orphan.child")?.parentId,
    ).toBe("orphan");
  });

  it("retains new default descendants when their formerly empty parent was deleted", () => {
    const evolvedDefinition = {
      ...DEFINITION,
      nodes: [
        ...DEFINITION.nodes,
        {
          id: "image.edit",
          kind: "folder",
          label: "Edit",
          parentId: "image",
          order: 2,
        },
        {
          id: "image.edit.new",
          kind: "folder",
          label: "New default",
          parentId: "image.edit",
          order: 0,
        },
      ],
    } as const;
    const layout = resolveMenuTreeLayout(
      evolvedDefinition,
      {
        version: MENU_TREE_VERSION,
        customNodes: [],
        nodeOverrides: [{ id: "image.edit", deleted: true }],
        leafPlacements: [],
      },
      ["flux.json"],
    );

    expect(layout.nodes.some((node) => node.id === "image.edit")).toBe(false);
    expect(
      layout.nodes.find((node) => node.id === "image.edit.new")?.parentId,
    ).toBe(null);
  });

  it("carries forward placements for leaves the layout never saw", () => {
    const previous = {
      version: MENU_TREE_VERSION,
      customNodes: [],
      nodeOverrides: [],
      leafPlacements: [
        { leafId: "flux.json", parentId: null, order: 3 },
        { leafId: "absent.json", parentId: "image.generate", order: 0 },
      ],
    } as const;

    // "absent.json" is not installed right now, so it never reaches the layout.
    const layout = resolveMenuTreeLayout(DEFINITION, previous, ["flux.json"]);
    expect(
      layout.leafPlacements.map((placement) => placement.leafId),
    ).toEqual(["flux.json"]);

    const customization = createMenuTreeCustomization(
      DEFINITION,
      layout,
      previous,
    );
    expect(customization.leafPlacements).toContainEqual({
      leafId: "absent.json",
      parentId: "image.generate",
      order: 0,
    });

    // Without the previous customization the placement is lost.
    expect(
      createMenuTreeCustomization(DEFINITION, layout).leafPlacements,
    ).not.toContainEqual(expect.objectContaining({ leafId: "absent.json" }));
  });
});
