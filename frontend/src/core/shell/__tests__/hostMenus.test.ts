import { describe, expect, it } from "vitest";
import { hostMenuCatalog } from "../hostMenuCatalog";
import { declareHostMenus } from "../hostMenus";

declareHostMenus();

describe("Wave 3 host menu subjects", () => {
  it.each([
    [
      "masks.add.options",
      {
        slot: "masks.add.options",
        target: { clipId: "clip-1", maskCount: 2 },
      },
    ],
    [
      "transformations.path.add",
      {
        slot: "transformations.path.add",
        target: { clipId: "clip-1", trackableMaskCount: 1 },
      },
    ],
    [
      "generation.generate.options",
      {
        slot: "generation.generate.options",
        generation: { workflowId: null },
      },
    ],
    [
      "app.workspace.select",
      {
        slot: "app.workspace.select",
        sidebar: {
          location: "right-sidebar",
          selectedWorkspaceId: "workspace-1",
        },
      },
    ],
    [
      "library.sort.options",
      {
        slot: "library.sort.options",
        browser: { sortOption: "date-desc" },
      },
    ],
  ] as const)("validates %s", (menuId, subject) => {
    expect(hostMenuCatalog.validateSubject(menuId, subject)).toBe(true);
  });

  it("rejects non-finite and fractional collection counts", () => {
    expect(
      hostMenuCatalog.validateSubject("masks.add.options", {
        slot: "masks.add.options",
        target: { clipId: "clip-1", maskCount: Number.NaN },
      }),
    ).toBe(false);
    expect(
      hostMenuCatalog.validateSubject("transformations.path.add", {
        slot: "transformations.path.add",
        target: { clipId: "clip-1", trackableMaskCount: 0.5 },
      }),
    ).toBe(false);
  });
});

