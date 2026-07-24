import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_TREE_VERSION, type MenuTreeDefinition } from "../menuTree";
import {
  loadMenuTreeCustomization,
  resetMenuTreeLayout,
  saveMenuTreeLayout,
} from "../menuTreePersistence";

const DEFINITION: MenuTreeDefinition = {
  version: MENU_TREE_VERSION,
  id: "generation.workflows",
  nodes: [],
  leafPlacements: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("menuTreePersistence", () => {
  it("loads customization while retaining newly available leaves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            revision: 2,
            customization: {
              version: 1,
              customNodes: [],
              nodeOverrides: [],
              leafPlacements: [],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const snapshot = await loadMenuTreeCustomization(DEFINITION, ["new.json"]);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.layout.leafPlacements).toEqual([
      { leafId: "new.json", parentId: null, order: 0 },
    ]);
  });

  it("sends revisions on save and uses DELETE for reset", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revision: 4,
            customization: {
              version: 1,
              customNodes: [],
              nodeOverrides: [],
              leafPlacements: [
                { leafId: "new.json", parentId: null, order: 0 },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 0, customization: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const layout = {
      nodes: [],
      leafPlacements: [{ leafId: "new.json", parentId: null, order: 0 }],
    };
    await saveMenuTreeLayout(DEFINITION, ["new.json"], layout, 3, null);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/app/menu-layouts/generation.workflows",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"baseRevision":3'),
      }),
    );

    await resetMenuTreeLayout(DEFINITION, ["new.json"]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/app/menu-layouts/generation.workflows",
      { method: "DELETE" },
    );
  });

  it("surfaces backend error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Revision conflict" } }),
          { status: 409 },
        ),
      ),
    );

    await expect(
      saveMenuTreeLayout(
        DEFINITION,
        [],
        { nodes: [], leafPlacements: [] },
        1,
        null,
      ),
    ).rejects.toThrow("Revision conflict");
  });
});
