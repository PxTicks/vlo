import { describe, expect, it } from "vitest";
import { resolveShellLayout } from "../layoutResolver";
import {
  DOCK_REGION_CONSTRAINTS,
  type DockRegion,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
} from "../layoutTypes";

function panel(
  id: string,
  overrides: Partial<ShellPanelDescriptor> = {},
): ShellPanelDescriptor {
  const defaultRegion = overrides.defaultRegion ?? "left-sidebar";
  return {
    id,
    defaultRegion,
    allowedRegions: [defaultRegion],
    defaultOrder: 0,
    available: true,
    source: "host",
    ...overrides,
  };
}

function document(
  partial: Partial<Omit<ShellLayoutDocumentV2, "version">> = {},
): ShellLayoutDocumentV2 {
  return {
    version: 2,
    panels: {},
    regions: {},
    workspaceLayouts: {},
    ...partial,
  };
}

function region(
  panels: readonly ShellPanelDescriptor[],
  doc: ShellLayoutDocumentV2,
  id: DockRegion = "left-sidebar",
) {
  return resolveShellLayout({ panels, document: doc }).regions[id];
}

describe("lower-stage geometry", () => {
  it("clamps the effective height without overwriting desktop intent", () => {
    const resolved = resolveShellLayout({
      panels: [],
      document: document({
        lowerStage: { collapsed: true, sizePx: 600 },
      }),
      viewport: { widthPx: 1200, heightPx: 400 },
    });

    expect(resolved.lowerStage).toMatchObject({
      id: "lower-stage",
      collapsed: true,
      sizePx: 260,
      userSizePx: 600,
      minimumSizePx: 160,
      maximumSizePx: 720,
    });
  });
});

describe("placement", () => {
  it("places panels in their registered region by default", () => {
    const resolved = resolveShellLayout({
      panels: [
        panel("host.assets"),
        panel("host.scopes", { defaultRegion: "bottom-dock" }),
      ],
      document: document(),
    });

    expect(resolved.panelRegions).toEqual({
      "host.assets": "left-sidebar",
      "host.scopes": "bottom-dock",
    });
    expect(resolved.regions["left-sidebar"].placedViewIds).toEqual([
      "host.assets",
    ]);
    expect(resolved.regions["right-sidebar"].placedViewIds).toEqual([]);
  });

  it("honours a saved placement the panel permits", () => {
    const resolved = resolveShellLayout({
      panels: [
        panel("host.scopes", {
          defaultRegion: "bottom-dock",
          allowedRegions: ["bottom-dock", "right-sidebar"],
        }),
      ],
      document: document({
        panels: { "host.scopes": { region: "right-sidebar" } },
      }),
    });

    expect(resolved.panelRegions["host.scopes"]).toBe("right-sidebar");
    expect(resolved.regions["bottom-dock"].placedViewIds).toEqual([]);
  });

  it("falls back to the registered region when a saved placement is no longer allowed", () => {
    const resolved = resolveShellLayout({
      panels: [panel("host.scopes", { defaultRegion: "bottom-dock" })],
      document: document({
        panels: { "host.scopes": { region: "right-sidebar" } },
      }),
    });

    expect(resolved.panelRegions["host.scopes"]).toBe("bottom-dock");
  });

  it("tolerates a duplicate registration without placing a panel twice", () => {
    const resolved = resolveShellLayout({
      panels: [panel("host.assets"), panel("host.assets", { defaultOrder: 9 })],
      document: document(),
    });

    expect(resolved.regions["left-sidebar"].placedViewIds).toEqual([
      "host.assets",
    ]);
  });
});

describe("ordering", () => {
  it("uses registration order, then identifier, when the user has no preference", () => {
    const resolved = region(
      [
        panel("host.b", { defaultOrder: 20 }),
        panel("host.a", { defaultOrder: 20 }),
        panel("host.first", { defaultOrder: 10 }),
      ],
      document(),
    );

    expect(resolved.placedViewIds).toEqual(["host.first", "host.a", "host.b"]);
  });

  it("puts explicitly ordered panels ahead of panels the user never touched", () => {
    const resolved = region(
      [
        panel("host.a", { defaultOrder: 10 }),
        panel("host.b", { defaultOrder: 20 }),
        panel("example.a/new", { defaultOrder: 5, source: "extension" }),
      ],
      document({
        panels: { "host.b": { order: 0 }, "host.a": { order: 1 } },
      }),
    );

    expect(resolved.placedViewIds).toEqual([
      "host.b",
      "host.a",
      "example.a/new",
    ]);
  });
});

describe("visibility and availability", () => {
  it("keeps hidden and unavailable panels placed but out of the tab strip", () => {
    const resolved = region(
      [
        panel("host.a", { defaultOrder: 10 }),
        panel("host.hidden", { defaultOrder: 20 }),
        panel("host.gated", { defaultOrder: 30, available: false }),
      ],
      document({ panels: { "host.hidden": { visible: false } } }),
    );

    expect(resolved.placedViewIds).toEqual([
      "host.a",
      "host.hidden",
      "host.gated",
    ]);
    expect(resolved.orderedViewIds).toEqual(["host.a"]);
  });

  it("keeps a panel that registered hidden off the tab strip until it is asked for", () => {
    const panels = [
      panel("host.a", { defaultOrder: 10 }),
      panel("host.opt-in", { defaultOrder: 20, defaultVisible: false }),
    ];

    const untouched = region(panels, document());
    expect(untouched.placedViewIds).toEqual(["host.a", "host.opt-in"]);
    expect(untouched.orderedViewIds).toEqual(["host.a"]);

    // An explicit placement is the user's intent and outranks the default.
    const revealed = region(
      panels,
      document({ panels: { "host.opt-in": { visible: true } } }),
    );
    expect(revealed.orderedViewIds).toEqual(["host.a", "host.opt-in"]);
  });
});

describe("selection fallback", () => {
  it("keeps a saved selection that is still visible and available", () => {
    const resolved = region(
      [panel("host.a", { defaultOrder: 10 }), panel("host.b", { defaultOrder: 20 })],
      document({ regions: { "left-sidebar": { selectedViewId: "host.b" } } }),
    );

    expect(resolved.selectedViewId).toBe("host.b");
  });

  it("moves to the nearest following sibling when the selection is hidden", () => {
    const resolved = region(
      [
        panel("host.a", { defaultOrder: 10 }),
        panel("host.b", { defaultOrder: 20 }),
        panel("host.c", { defaultOrder: 30 }),
      ],
      document({
        panels: { "host.b": { visible: false } },
        regions: { "left-sidebar": { selectedViewId: "host.b" } },
      }),
    );

    expect(resolved.selectedViewId).toBe("host.c");
  });

  it("moves backwards when nothing follows the lost selection", () => {
    const resolved = region(
      [
        panel("host.a", { defaultOrder: 10 }),
        panel("host.b", { defaultOrder: 20 }),
        panel("host.c", { defaultOrder: 30, available: false }),
      ],
      document({
        panels: { "host.b": { visible: false } },
        regions: { "left-sidebar": { selectedViewId: "host.b" } },
      }),
    );

    expect(resolved.selectedViewId).toBe("host.a");
  });

  it("falls back to the first host panel when the selected extension view is gone", () => {
    const resolved = region(
      [
        panel("example.a/tool", { defaultOrder: 5, source: "extension" }),
        panel("host.a", { defaultOrder: 10 }),
      ],
      document({
        regions: { "left-sidebar": { selectedViewId: "example.b/removed" } },
      }),
    );

    expect(resolved.selectedViewId).toBe("host.a");
  });

  it("selects a contributed panel only when nothing native remains", () => {
    const resolved = region(
      [panel("example.a/tool", { source: "extension" })],
      document(),
    );

    expect(resolved.selectedViewId).toBe("example.a/tool");
  });

  it("reports an empty region rather than inventing a selection", () => {
    const resolved = region(
      [panel("host.a", { available: false })],
      document({ regions: { "left-sidebar": { selectedViewId: "host.a" } } }),
    );

    expect(resolved.orderedViewIds).toEqual([]);
    expect(resolved.selectedViewId).toBeNull();
  });

  it("leaves the bottom dock closed until something is explicitly selected", () => {
    const panels = [panel("host.scopes", { defaultRegion: "bottom-dock" })];

    expect(region(panels, document(), "bottom-dock").selectedViewId).toBeNull();
    expect(
      region(
        panels,
        document({
          regions: { "bottom-dock": { selectedViewId: "host.scopes" } },
        }),
        "bottom-dock",
      ).selectedViewId,
    ).toBe("host.scopes");
  });

  it("closes the bottom dock when the panel it had open unregisters entirely", () => {
    const resolved = region(
      [panel("host.scopes", { defaultRegion: "bottom-dock" })],
      document({
        regions: { "bottom-dock": { selectedViewId: "example.a/removed" } },
      }),
      "bottom-dock",
    );

    expect(resolved.selectedViewId).toBeNull();
  });

  it("slides the bottom dock to a sibling rather than closing when its view is only disabled", () => {
    const resolved = region(
      [
        panel("host.scopes", { defaultRegion: "bottom-dock", defaultOrder: 10 }),
        panel("example.a/report", {
          defaultRegion: "bottom-dock",
          defaultOrder: 20,
          source: "extension",
        }),
      ],
      document({
        panels: { "host.scopes": { visible: false } },
        regions: { "bottom-dock": { selectedViewId: "host.scopes" } },
      }),
      "bottom-dock",
    );

    expect(resolved.selectedViewId).toBe("example.a/report");
  });
});

describe("collapse", () => {
  it("honours a saved collapse for a collapsible region", () => {
    const resolved = region(
      [panel("host.a")],
      document({ regions: { "left-sidebar": { collapsed: true } } }),
    );

    expect(resolved.collapsed).toBe(true);
    // Collapsing keeps the region's size and selection for restoration.
    expect(resolved.selectedViewId).toBe("host.a");
    expect(resolved.sizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].defaultSizePx,
    );
  });

  it("ignores a saved collapse for a region that cannot collapse", () => {
    const constraints = {
      ...DOCK_REGION_CONSTRAINTS,
      "left-sidebar": {
        ...DOCK_REGION_CONSTRAINTS["left-sidebar"],
        collapsible: false,
      },
    };
    const resolved = resolveShellLayout({
      panels: [panel("host.a")],
      document: document({ regions: { "left-sidebar": { collapsed: true } } }),
      constraints,
    });

    expect(resolved.regions["left-sidebar"].collapsed).toBe(false);
  });

  it("derives narrow collapse separately from persisted intent", () => {
    const input = {
      panels: [
        panel("host.a"),
        panel("host.b", { defaultRegion: "right-sidebar" }),
      ],
      document: document(),
      viewport: { widthPx: 600, heightPx: 700 },
    } as const;

    const collapsed = resolveShellLayout(input);
    expect(collapsed.regions["left-sidebar"]).toMatchObject({
      collapsed: true,
      userCollapsed: false,
    });
    expect(collapsed.regions["right-sidebar"]).toMatchObject({
      collapsed: true,
      userCollapsed: false,
    });

    const leftOpen = resolveShellLayout({
      ...input,
      responsiveExpandedRegion: "left-sidebar",
    });
    expect(leftOpen.regions["left-sidebar"].collapsed).toBe(false);
    expect(leftOpen.regions["right-sidebar"].collapsed).toBe(true);
    expect(leftOpen.regions["left-sidebar"].userCollapsed).toBe(false);
  });
});

describe("sizing", () => {
  it("uses the region default when nothing is saved", () => {
    const resolved = region([panel("host.a")], document());

    expect(resolved.sizePx).toBe(356);
    expect(resolved.userSizePx).toBe(356);
  });

  it("prefers the selected panel's hint over the region default", () => {
    const resolved = region(
      [panel("host.a", { preferredSizePx: 420 })],
      document(),
    );

    expect(resolved.userSizePx).toBe(420);
  });

  it("lets a saved size override the panel hint", () => {
    const resolved = region(
      [panel("host.a", { preferredSizePx: 420 })],
      document({ regions: { "left-sidebar": { sizePx: 300 } } }),
    );

    expect(resolved.userSizePx).toBe(300);
  });

  it("clamps a saved size to the region constraints", () => {
    expect(
      region([panel("host.a")], document({ regions: { "left-sidebar": { sizePx: 9000 } } }))
        .userSizePx,
    ).toBe(DOCK_REGION_CONSTRAINTS["left-sidebar"].maximumSizePx);
    expect(
      region([panel("host.a")], document({ regions: { "left-sidebar": { sizePx: 10 } } }))
        .userSizePx,
    ).toBe(DOCK_REGION_CONSTRAINTS["left-sidebar"].minimumSizePx);
  });

  it("lets the selected panel tighten, but never loosen, the region bounds", () => {
    const tightened = region(
      [panel("host.a", { minimumSizePx: 400, maximumSizePx: 500 })],
      document({ regions: { "left-sidebar": { sizePx: 300 } } }),
    );
    expect(tightened.minimumSizePx).toBe(400);
    expect(tightened.maximumSizePx).toBe(500);
    expect(tightened.userSizePx).toBe(400);

    const loosened = region(
      [panel("host.a", { minimumSizePx: 10, maximumSizePx: 10_000 })],
      document({ regions: { "left-sidebar": { sizePx: 10 } } }),
    );
    expect(loosened.minimumSizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].minimumSizePx,
    );
    expect(loosened.maximumSizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].maximumSizePx,
    );
  });

  it("survives a panel whose declared bounds are inverted", () => {
    const resolved = region(
      [panel("host.a", { minimumSizePx: 500, maximumSizePx: 200 })],
      document(),
    );

    expect(resolved.minimumSizePx).toBe(500);
    expect(resolved.maximumSizePx).toBe(500);
    expect(resolved.userSizePx).toBe(500);
  });

  it("pins a panel minimum larger than the region can give to the region maximum", () => {
    const resolved = region(
      [panel("host.a", { minimumSizePx: 900 })],
      document({ regions: { "left-sidebar": { sizePx: 9000 } } }),
    );

    const regionMaximum = DOCK_REGION_CONSTRAINTS["left-sidebar"].maximumSizePx;
    expect(resolved.minimumSizePx).toBe(regionMaximum);
    expect(resolved.maximumSizePx).toBe(regionMaximum);
    expect(resolved.userSizePx).toBe(regionMaximum);
  });

  it("raises a panel maximum below the region minimum instead of breaching it", () => {
    const resolved = region(
      [panel("host.a", { maximumSizePx: 100 })],
      document({ regions: { "left-sidebar": { sizePx: 50 } } }),
    );

    const regionMinimum = DOCK_REGION_CONSTRAINTS["left-sidebar"].minimumSizePx;
    expect(resolved.minimumSizePx).toBe(regionMinimum);
    expect(resolved.maximumSizePx).toBe(regionMinimum);
    expect(resolved.userSizePx).toBe(regionMinimum);
  });

  it("keeps the region hard maximum authoritative for every malformed descriptor", () => {
    const malformed: readonly Partial<ShellPanelDescriptor>[] = [
      { minimumSizePx: 900 },
      { minimumSizePx: 100_000, maximumSizePx: 100_000 },
      { minimumSizePx: 900, maximumSizePx: 50 },
      { minimumSizePx: 700, maximumSizePx: Number.POSITIVE_INFINITY },
      { preferredSizePx: 5000, minimumSizePx: 5000 },
    ];

    for (const regionId of ["left-sidebar", "bottom-dock"] as const) {
      const regionMaximum = DOCK_REGION_CONSTRAINTS[regionId].maximumSizePx;
      for (const bounds of malformed) {
        const resolved = region(
          [panel("host.a", { defaultRegion: regionId, ...bounds })],
          document({
            regions: {
              [regionId]: { selectedViewId: "host.a", sizePx: 100_000 },
            },
          }),
          regionId,
        );

        expect(resolved.minimumSizePx).toBeLessThanOrEqual(regionMaximum);
        expect(resolved.maximumSizePx).toBeLessThanOrEqual(regionMaximum);
        expect(resolved.userSizePx).toBeLessThanOrEqual(regionMaximum);
        expect(resolved.sizePx).toBeLessThanOrEqual(regionMaximum);
      }
    }
  });

  it("resolves an inverted region configuration in the maximum's favour", () => {
    const constraints = {
      ...DOCK_REGION_CONSTRAINTS,
      "left-sidebar": {
        ...DOCK_REGION_CONSTRAINTS["left-sidebar"],
        minimumSizePx: 900,
        maximumSizePx: 400,
      },
    };
    const resolved = resolveShellLayout({
      panels: [panel("host.a", { minimumSizePx: 800 })],
      document: document(),
      constraints,
    }).regions["left-sidebar"];

    expect(resolved.minimumSizePx).toBe(400);
    expect(resolved.maximumSizePx).toBe(400);
    expect(resolved.userSizePx).toBe(400);
  });

  it("shrinks the rendered size on a narrow viewport without touching the preference", () => {
    const resolved = resolveShellLayout({
      panels: [panel("host.a")],
      document: document({ regions: { "left-sidebar": { sizePx: 500 } } }),
      viewport: { widthPx: 800, heightPx: 600 },
    });

    // 40% of 800px, while the desktop preference stays at 500px.
    expect(resolved.regions["left-sidebar"].sizePx).toBe(320);
    expect(resolved.regions["left-sidebar"].userSizePx).toBe(500);
  });

  it("clamps the bottom dock against viewport height rather than width", () => {
    const resolved = resolveShellLayout({
      panels: [panel("host.scopes", { defaultRegion: "bottom-dock" })],
      document: document({
        regions: {
          "bottom-dock": { selectedViewId: "host.scopes", sizePx: 700 },
        },
      }),
      viewport: { widthPx: 4000, heightPx: 600 },
    });

    expect(resolved.regions["bottom-dock"].sizePx).toBe(360);
    expect(resolved.regions["bottom-dock"].userSizePx).toBe(700);
  });

  it("ignores a degenerate viewport", () => {
    const resolved = resolveShellLayout({
      panels: [panel("host.a")],
      document: document(),
      viewport: { widthPx: 0, heightPx: Number.NaN },
    });

    expect(resolved.regions["left-sidebar"].sizePx).toBe(356);
  });
});
