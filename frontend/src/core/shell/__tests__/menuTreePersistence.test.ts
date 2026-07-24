import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_TREE_VERSION, type MenuTreeDefinition } from "../menuTree";
import {
  fetchMenuTreeCustomization,
  resetMenuTreeCustomization,
  saveMenuTreeCustomization,
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
  it("fetches customization without resolving consumer leaves", async () => {
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

    const snapshot = await fetchMenuTreeCustomization(DEFINITION.id);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.customization).toEqual({
      version: MENU_TREE_VERSION,
      customNodes: [],
      nodeOverrides: [],
      leafPlacements: [],
    });
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

    const customization = {
      version: MENU_TREE_VERSION,
      customNodes: [],
      nodeOverrides: [],
      leafPlacements: [
        { leafId: "new.json", parentId: null, order: 0 },
      ],
    };
    await saveMenuTreeCustomization(DEFINITION.id, customization, 3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/app/menu-layouts/generation.workflows",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"baseRevision":3'),
      }),
    );

    await resetMenuTreeCustomization(DEFINITION.id);
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
      saveMenuTreeCustomization(
        DEFINITION.id,
        {
          version: MENU_TREE_VERSION,
          customNodes: [],
          nodeOverrides: [],
          leafPlacements: [],
        },
        1,
      ),
    ).rejects.toThrow("Revision conflict");
  });
});
