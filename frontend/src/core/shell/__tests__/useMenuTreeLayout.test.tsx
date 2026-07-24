import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MENU_TREE_VERSION,
  type MenuTreeDefinition,
} from "../menuTree";
import { useMenuTreeLayout } from "../useMenuTreeLayout";

const DEFINITION: MenuTreeDefinition = {
  version: MENU_TREE_VERSION,
  id: "generation.workflows",
  nodes: [],
  leafPlacements: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMenuTreeLayout", () => {
  it("publishes newly available leaves without refetching persistence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          revision: 1,
          customization: {
            version: MENU_TREE_VERSION,
            customNodes: [],
            nodeOverrides: [],
            leafPlacements: [],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ leafIds }: { leafIds: readonly string[] }) =>
        useMenuTreeLayout(DEFINITION, leafIds),
      { initialProps: { leafIds: [] as readonly string[] } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ leafIds: ["new.json"] });

    expect(result.current.layout.leafPlacements).toEqual([
      { leafId: "new.json", parentId: null, order: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
