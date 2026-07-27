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
      "app.view.select",
      {
        slot: "app.view.select",
        region: {
          id: "right-sidebar",
          selectedViewId: "view-1",
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
    [
      "app.settings",
      {
        slot: "app.settings",
        app: { workflowMode: "high_vram", comfyuiConfigured: true },
      },
    ],
    [
      "projects.item.context",
      {
        slot: "projects.item.context",
        project: {
          id: "recent-1",
          name: "Project one",
          lastOpened: 1_700_000_000_000,
          pathToken: "recent-1",
        },
      },
    ],
  ] as const)("validates %s", (menuId, subject) => {
    expect(hostMenuCatalog.validateSubject(menuId, subject)).toBe(true);
  });

  it("rejects an app.settings subject carrying project state", () => {
    expect(
      hostMenuCatalog.validateSubject("app.settings", {
        slot: "app.settings",
        app: { workflowMode: "default" },
      }),
    ).toBe(false);
    expect(
      hostMenuCatalog.validateSubject("app.settings", {
        slot: "app.project.settings",
        app: { workflowMode: "default", comfyuiConfigured: false },
      }),
    ).toBe(false);
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
