import { describe, expect, it } from "vitest";
import { resolveShellLayout } from "../../layout/layoutResolver";
import type {
  ShellLayoutDocumentV2,
  ShellPanelDescriptor,
} from "../../layout/layoutTypes";
import {
  captureWorkspaceLayoutOverride,
  createWorkspaceLayoutDocument,
  getWorkspaceStageSurfaces,
} from "../workspaceLayout";

const PANELS: readonly ShellPanelDescriptor[] = [
  {
    id: "host.library",
    defaultRegion: "left-sidebar",
    allowedRegions: ["left-sidebar"],
    defaultOrder: 0,
    available: true,
    source: "host",
  },
  {
    id: "host.scopes",
    defaultRegion: "bottom-dock",
    allowedRegions: ["bottom-dock", "right-sidebar"],
    defaultOrder: 0,
    available: true,
    source: "host",
  },
  {
    id: "host.notes",
    defaultRegion: "right-sidebar",
    allowedRegions: ["right-sidebar"],
    defaultOrder: 0,
    available: true,
    source: "host",
  },
];

const BASE: ShellLayoutDocumentV2 = {
  version: 2,
  panels: { "host.library": { order: 4 } },
  regions: { "left-sidebar": { sizePx: 310 } },
  lowerStage: { sizePx: 260 },
  workspaceLayouts: {},
};

describe("workspace layout layers", () => {
  it("applies explicit saved customization over composition defaults", () => {
    const document = createWorkspaceLayoutDocument({
      base: BASE,
      override: {
        panels: { "host.scopes": { region: "bottom-dock", order: 2 } },
        regions: {
          "right-sidebar": { sizePx: 420 },
          "bottom-dock": { selectedViewId: "host.scopes" },
        },
        lowerStage: { sizePx: 360 },
      },
      composition: {
        docks: {
          "right-sidebar": {
            mode: "augment",
            panels: [{ viewId: "host.scopes" }],
            selectedViewId: "host.scopes",
          },
        },
      },
      panels: PANELS,
    });

    expect(document.panels["host.scopes"]).toEqual({
      region: "bottom-dock",
      visible: true,
      order: 2,
    });
    expect(document.regions["right-sidebar"]).toEqual({
      sizePx: 420,
      selectedViewId: "host.scopes",
      collapsed: false,
    });
    expect(document.regions["bottom-dock"]?.selectedViewId).toBe("host.scopes");
    expect(document.lowerStage).toEqual({ sizePx: 360 });
    expect(BASE.panels).toEqual({ "host.library": { order: 4 } });
  });

  it("replace mode hides only panels left in the replaced region", () => {
    const document = createWorkspaceLayoutDocument({
      base: BASE,
      composition: {
        docks: {
          "left-sidebar": {
            mode: "replace",
            panels: [],
          },
          "right-sidebar": {
            mode: "replace",
            panels: [{ viewId: "host.scopes" }],
          },
        },
      },
      panels: PANELS,
    });

    expect(document.panels["host.library"]?.visible).toBe(false);
    expect(document.panels["host.notes"]?.visible).toBe(false);
    expect(document.panels["host.scopes"]).toMatchObject({
      region: "right-sidebar",
      visible: true,
    });
  });

  it("does not let a saved override hide a required panel", () => {
    const document = createWorkspaceLayoutDocument({
      base: BASE,
      override: {
        panels: { "host.scopes": { visible: false } },
        regions: {},
      },
      composition: {
        docks: {
          "bottom-dock": {
            mode: "replace",
            panels: [{ viewId: "host.scopes", required: true }],
          },
        },
      },
      panels: PANELS,
    });

    expect(document.panels["host.scopes"]?.visible).toBe(true);
  });

  it("extracts stage choices and saves only deltas from the composition", () => {
    expect(
      getWorkspaceStageSurfaces({
        stages: {
          "main-stage": { surfaceId: "host.preview" },
          "lower-stage": { surfaceId: "host.tools" },
        },
      }),
    ).toEqual({
      "main-stage": "host.preview",
      "lower-stage": "host.tools",
    });

    const composed = createWorkspaceLayoutDocument({
      base: BASE,
      composition: {
        docks: {
          "right-sidebar": {
            mode: "replace",
            panels: [{ viewId: "host.scopes" }],
          },
        },
      },
      panels: PANELS,
    });
    const composedResolved = resolveShellLayout({
      panels: PANELS,
      document: composed,
    });
    expect(
      captureWorkspaceLayoutOverride({
        document: composed,
        resolved: composedResolved,
        baselineDocument: composed,
        baselineResolved: composedResolved,
        panels: PANELS,
      }),
    ).toEqual({ panels: {}, regions: {} });

    const baselineResolved = resolveShellLayout({
      panels: PANELS,
      document: BASE,
    });
    const changed: ShellLayoutDocumentV2 = {
      ...BASE,
      panels: {
        ...BASE.panels,
        "host.scopes": { region: "right-sidebar", visible: false },
      },
      regions: {
        ...BASE.regions,
        "right-sidebar": { sizePx: 420 },
      },
      lowerStage: { sizePx: 300 },
    };
    expect(
      captureWorkspaceLayoutOverride({
        document: changed,
        resolved: resolveShellLayout({ panels: PANELS, document: changed }),
        baselineDocument: BASE,
        baselineResolved,
        panels: PANELS,
      }),
    ).toEqual({
      panels: {
        "host.scopes": {
          region: "right-sidebar",
          visible: false,
          order: 1,
        },
      },
      regions: { "right-sidebar": { sizePx: 420 } },
      lowerStage: { sizePx: 300 },
    });
  });
});
