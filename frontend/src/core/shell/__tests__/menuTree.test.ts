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
});
